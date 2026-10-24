import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  finishImplementation,
  reconcileImplementationHandoff,
  openSqliteState,
  readRunEvents,
  handoffRequestSchema,
  handoffReadResultSchema,
  executeLocalHandoff,
  acquireCoordinatorOwnership,
  type HandoffDependencies,
} from '../src/index.js';
import { completed } from '../src/contracts/operation-result.js';
import { fixture, persisted } from './support/handoff.js';
import { git } from './support/service.js';
const options = { timeout: 90000 };

await test(
  'handoff publishes the completed commit and atomically saves a requested review while retaining worker resources',
  options,
  async () => {
    await fixture(async (f) => {
      const before = f.deps.runs.inspect(f.job.job.id);
      const value = persisted(await finishImplementation(f.input, f.deps));
      const after = f.deps.runs.inspect(f.job.job.id);

      assert.equal(value.record.phase, 'accepted');
      assert.equal(value.push.state, 'confirmed');
      assert.equal(value.publication.state, 'confirmed');
      assert.equal(value.record.followUpReview?.state, 'requested');
      assert.equal(value.record.followUpReview?.target.sha, f.head);
      assert.equal(value.record.followUpReview?.sourceReportId, f.request.reportId);
      assert.equal(f.remote.pushCalls, 1);
      assert.equal(f.remote.postCalls, 1);
      assert.ok(
        before.outcome === 'completed' &&
          before.value &&
          after.outcome === 'completed' &&
          after.value,
      );
      assert.deepEqual(after.value.cleanup, before.value.cleanup);
      assert.deepEqual(after.value.control, before.value.control);
      assert.equal(after.value.job.attempt.id, before.value.job.attempt.id);
      assert.notEqual(value.record.publicationAttemptId, f.job.attempt.id);

      const cli = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../dist/cli/main.js', import.meta.url)),
          '--state-directory',
          f.context.context.state,
          'handoff',
          'inspect',
          f.job.job.id,
          '--json',
        ],
        {
          cwd: f.context.context.root,
          encoding: 'utf8',
          timeout: 10000,
          env: { HOME: f.context.context.root, PATH: '/usr/bin:/bin' },
        },
      );

      assert.equal(cli.status, 0, cli.stderr);

      const envelope = handoffReadResultSchema.parse(JSON.parse(cli.stdout) as unknown);

      assert.ok(envelope.outcome === 'completed' && envelope.value);
      assert.equal(envelope.value.record.id, value.record.id);

      const follows = f.deps.handoffs.followUps({
        projectId: f.job.job.projectId,
        after: '',
        limit: 20,
      });

      assert.ok(follows.outcome === 'completed');
      assert.deepEqual(follows.value.items, [value.record.followUpReview]);

      const events = await readRunEvents(
        { schemaVersion: 1, jobId: f.job.job.id, after: 0, limit: 100, waitMs: 0 },
        { runs: f.deps.runs, now: Date.now, waiter: { pause: async () => {} } },
      );

      assert.ok(events.outcome === 'completed');
      assert.equal(events.value.events.filter((e) => e.kind === 'handoff_accepted').length, 1);
    });
  },
);

await test(
  'accepted retries survive reopen and require no checkout, provider or artifact access',
  options,
  async () => {
    await fixture(async (f) => {
      const first = persisted(await finishImplementation(f.input, f.deps));
      const opened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: f.context.context.state,
      });

      assert.ok(opened.outcome === 'opened');

      try {
        const deps: HandoffDependencies = {
          ...f.deps,
          state: opened.store,
          handoffs: opened.handoffs,
          runs: opened.runs,
          git: { inspect: async () => assert.fail('Cached acceptance must not inspect Git') },
          artifacts: {
            inspect: async () => assert.fail('Cached acceptance must not inspect artifacts'),
          },
        };
        const repeated = persisted(await finishImplementation(f.input, deps));

        assert.deepEqual(repeated, first);
        assert.equal(f.remote.pushCalls, 1);
        assert.equal(f.remote.postCalls, 1);
      } finally {
        opened.store.close();
      }
    });
  },
);

await test(
  'manual-only publication saves no review request and rejects changed content under an existing key',
  options,
  async () => {
    await fixture(async (f) => {
      const input = { ...f.input, request: { ...f.request, review: null } };
      const result = persisted(await finishImplementation(input, f.deps));

      assert.equal(result.record.followUpReview, null);
      assert.equal((await finishImplementation(f.input, f.deps)).outcome, 'rejected');
      assert.equal(f.remote.postCalls, 1);

      const follows = f.deps.handoffs.followUps({
        projectId: f.job.job.projectId,
        after: '',
        limit: 20,
      });

      assert.ok(follows.outcome === 'completed');
      assert.deepEqual(follows.value.items, []);
    });
  },
);

for (const change of [
  'dirty',
  'local-head',
  'report',
  'publication-sha',
  'branch',
  'input',
  'artifact',
  'verification-artifact',
  'ownership',
  'attestation',
] as const) {
  await test(
    `handoff rejects ${change} mismatch before reserving or publishing`,
    options,
    async () => {
      await fixture(async (f) => {
        let input = structuredClone(f.input);
        let deps = f.deps;

        if (change === 'dirty') {
          await writeFile(join(f.root, 'untracked.txt'), 'Preserve me');
        } else if (change === 'local-head') {
          git(f.root, 'commit', '--allow-empty', '-m', 'unexpected commit');
        } else if (change === 'report') {
          input.request.reportId = 'wrong-report';
        } else if (change === 'publication-sha') {
          input.request.publication.headSha = 'f'.repeat(40);
        } else if (change === 'branch') {
          input.request.publication.headBranch = 'wrong-branch';
        } else if (change === 'input') {
          deps = { ...deps, workerInput: { receipt: () => completed(null) } };
        } else if (change === 'artifact') {
          await writeFile(join(f.root, f.artifact.path), 'Changed ignored artifact');
        } else if (change === 'verification-artifact') {
          input.request.verification.checks[0]!.artifact!.digest = 'f'.repeat(64);
        } else if (change === 'ownership') {
          deps = {
            ...deps,
            files: {
              ...deps.files,
              observe: async () => ({ container: 'unowned', checkout: 'present' }),
            },
          };
        } else {
          input = { ...input, writersStopped: false };
        }

        const result = await finishImplementation(input, deps);

        assert.equal(result.outcome, 'rejected', JSON.stringify(result));
        assert.equal(f.remote.pushCalls, 0);
        assert.equal(f.remote.postCalls, 0);

        const saved = deps.handoffs.find(f.job.job.id);

        assert.ok(saved.outcome === 'completed');
        assert.equal(saved.value, null);
      });
    },
  );
}

for (const stage of ['push', 'pr'] as const) {
  await test(
    `lost ${stage} response survives reopen and expiry, then read-only reconciliation never resends or starts the next stage`,
    options,
    async () => {
      await fixture(async (f) => {
        f.remote.pushMode = stage === 'push' ? 'lost' : 'success';
        f.remote.postMode = stage === 'pr' ? 'lost' : 'success';
        const first = persisted(await finishImplementation(f.input, f.deps));

        assert.equal(first.record.phase, 'prepared');
        assert.equal(stage === 'push' ? first.push.state : first.publication.state, 'unknown');

        const opened = await openSqliteState(
          { schemaVersion: 1, stateDirectory: f.context.context.state },
          { now: () => Date.now() + 100000 },
        );

        assert.ok(opened.outcome === 'opened');

        try {
          const deps = {
            ...f.deps,
            state: opened.store,
            runs: opened.runs,
            handoffs: opened.handoffs,
            now: () => 999999999,
          };
          const reconciled = persisted(await reconcileImplementationHandoff(f.reconcile, deps));

          assert.equal(reconciled.record.phase, stage === 'push' ? 'prepared' : 'accepted');
          assert.equal(f.remote.pushCalls, 1);
          assert.equal(f.remote.postCalls, stage === 'push' ? 0 : 1);

          f.remote.postMode = 'success';
          const finished = persisted(await finishImplementation(f.input, deps));

          assert.equal(finished.record.phase, 'accepted');
          assert.equal(f.remote.pushCalls, 1);
          assert.equal(f.remote.postCalls, 1);
        } finally {
          opened.store.close();
        }
      });
    },
  );
}

for (const stage of ['push', 'pr'] as const) {
  await test(
    `absent evidence for uncertain ${stage} remains unresolved and cannot be bypassed with a replacement key`,
    options,
    async () => {
      await fixture(async (f) => {
        f.remote.pushMode = stage === 'push' ? 'lost' : 'success';
        f.remote.postMode = stage === 'pr' ? 'lost' : 'success';
        const first = persisted(await finishImplementation(f.input, f.deps));

        if (stage === 'push') {
          f.remote.pushReceipt = null;
        } else {
          f.remote.receipt = null;
        }

        const observed = persisted(await reconcileImplementationHandoff(f.reconcile, f.deps));

        assert.equal(observed.record.phase, 'prepared');
        assert.equal(
          stage === 'push' ? observed.push.state : observed.publication.state,
          'unknown',
        );

        const replacement = await finishImplementation(
          { ...f.input, request: { ...f.request, key: 'replacement', replaces: first.record.id } },
          f.deps,
        );

        assert.equal(replacement.outcome, 'rejected');
        assert.equal(f.remote.pushCalls, 1);
        assert.equal(f.remote.postCalls, stage === 'push' ? 0 : 1);
      });
    },
  );
}

await test(
  'a process crash after claiming but before push never authorizes a retry by claim expiry',
  options,
  async () => {
    await fixture(async (f) => {
      const first = await finishImplementation(f.input, {
        ...f.deps,
        state: {
          ...f.deps.state,
          claimEffect: (request) => {
            const result = f.deps.state.claimEffect(request);

            assert.equal(result.outcome, 'persisted');

            throw new Error('Simulated controller crash');
          },
        },
      });

      assert.equal(first.outcome, 'rejected');
      assert.ok(f.inspect().push.claim);

      const retried = persisted(await finishImplementation(f.input, f.deps));

      assert.equal(retried.push.state, 'unknown');
      assert.equal(retried.record.phase, 'prepared');
      assert.equal(f.remote.pushCalls, 0);
      assert.equal(f.remote.postCalls, 0);
    });
  },
);

for (const stage of ['push', 'pr'] as const) {
  await test(
    `known ${stage} preflight failure requires explicit predecessor replacement and preserves its history`,
    options,
    async () => {
      await fixture(async (f) => {
        f.remote.pushMode = stage === 'push' ? 'rejected' : 'success';
        f.remote.postMode = stage === 'pr' ? 'rejected' : 'success';
        const first = persisted(await finishImplementation(f.input, f.deps));

        assert.equal(stage === 'push' ? first.push.state : first.publication.state, 'cancelled');
        assert.equal(
          (
            await finishImplementation(
              { ...f.input, request: { ...f.request, key: 'new-key' } },
              f.deps,
            )
          ).outcome,
          'rejected',
        );

        f.remote.pushMode = 'success';
        f.remote.postMode = 'success';
        const replacement = persisted(
          await finishImplementation(
            {
              ...f.input,
              request: { ...f.request, key: 'replacement', replaces: first.record.id },
            },
            f.deps,
          ),
        );

        assert.equal(replacement.record.phase, 'accepted');

        const old = f.deps.handoffs.find(f.job.job.id, f.request.key);

        assert.ok(old.outcome === 'completed' && old.value);
        assert.equal(old.value.record.phase, 'abandoned');
        assert.equal(old.value.publication.state, 'cancelled');
      });
    },
  );
}

await test(
  'fresh wrong remote SHA blocks PR creation after a successful push receipt',
  options,
  async () => {
    await fixture(async (f) => {
      const deps = {
        ...f.deps,
        publisher: {
          ...f.deps.publisher,
          inspect: async () =>
            completed({
              repository: { host: 'github.com', repository: 'example/project' },
              branch: f.request.publication.headBranch,
              sha: 'f'.repeat(40),
              observedAt: 1000,
            }),
        },
      };
      const result = await finishImplementation(f.input, deps);

      assert.equal(result.outcome, 'rejected');
      assert.equal(f.inspect().record.phase, 'prepared');
      assert.equal(f.remote.postCalls, 0);
    });
  },
);

await test(
  'PR metadata changes after publication block acceptance and never create another PR',
  options,
  async () => {
    await fixture(async (f) => {
      const deps = {
        ...f.deps,
        github: {
          ...f.deps.github,
          inspectPullRequest: async () => {
            assert.ok(f.remote.pr);

            return completed({
              ...f.remote.pr,
              target: { ...f.remote.pr.target, sha: 'f'.repeat(40) },
            });
          },
        },
      };
      const result = await finishImplementation(f.input, deps);

      assert.equal(result.outcome, 'rejected');
      assert.equal(f.inspect().publication.state, 'confirmed');
      assert.equal(f.inspect().record.phase, 'prepared');
      assert.equal((await finishImplementation(f.input, deps)).outcome, 'rejected');
      assert.equal(f.remote.postCalls, 1);
    });
  },
);

await test(
  'acceptance rolls back the review request when the transactional acceptance event fails',
  options,
  async () => {
    await fixture(async (f) => {
      const db = new DatabaseSync(join(f.context.context.state, 'state.sqlite'));

      try {
        db.exec(
          "CREATE TRIGGER reject_handoff_accept BEFORE INSERT ON run_events WHEN json_extract(NEW.data,'$.kind')='handoff_accepted' BEGIN SELECT RAISE(ABORT,'fixture acceptance event failure'); END;",
        );
        const failed = await finishImplementation(f.input, f.deps);

        assert.notEqual(failed.outcome, 'persisted');
        assert.equal(f.inspect().record.phase, 'prepared');
        assert.equal(f.inspect().record.followUpReview, null);

        db.exec('DROP TRIGGER reject_handoff_accept');
        const recovered = persisted(await reconcileImplementationHandoff(f.reconcile, f.deps));

        assert.equal(recovered.record.phase, 'accepted');
        assert.ok(recovered.record.followUpReview);
        assert.equal(f.remote.pushCalls, 1);
        assert.equal(f.remote.postCalls, 1);
      } finally {
        db.close();
      }
    });
  },
);

await test('two controllers converge on one push, PR and requested review', options, async () => {
  await fixture(async (f) => {
    const results = await Promise.all([
      finishImplementation(f.input, f.deps),
      finishImplementation(f.input, f.deps),
    ]);

    assert.ok(
      results.some(
        (result) => result.outcome === 'persisted' && result.value.record.phase === 'accepted',
      ),
    );
    assert.equal(f.remote.pushCalls, 1);
    assert.equal(f.remote.postCalls, 1);
    assert.equal(f.inspect().record.phase, 'accepted');
  });
});

await test(
  'cancellation before preparation leaves no intent or remote writes',
  options,
  async () => {
    await fixture(async (f) => {
      const controller = new AbortController();
      controller.abort();
      const result = await finishImplementation(f.input, f.deps, controller.signal);

      assert.ok(result.outcome === 'rejected' && result.error.code === 'cancelled');
      assert.equal(f.remote.pushCalls, 0);
      assert.equal(f.remote.postCalls, 0);
      assert.equal(
        handoffRequestSchema.safeParse({
          ...f.request,
          verification: { source: 'host-attestation', checks: [] },
        }).success,
        false,
      );
      assert.equal(
        (
          await finishImplementation(f.input, {
            ...f.deps,
            nextId: () => {
              throw new Error('No IDs');
            },
          })
        ).outcome,
        'rejected',
      );
      assert.equal(f.remote.pushCalls, 0);
    });
  },
);

for (const stage of ['push', 'pr'] as const) {
  await test(
    `uncertain local ${stage} receipt persistence is inspected without repeating external effects`,
    options,
    async () => {
      await fixture(async (f) => {
        let injected = false;
        const state = {
          ...f.deps.state,
          resolveEffect: (request: Parameters<typeof f.deps.state.resolveEffect>[0]) => {
            const result = f.deps.state.resolveEffect(request);
            const view = f.inspect();
            const selected =
              stage === 'push' ? view.record.pushEffectId : view.record.publicationEffectId;

            if (!injected && request.effectId === selected && result.outcome === 'persisted') {
              injected = true;

              return {
                schemaVersion: 1 as const,
                outcome: 'uncertain' as const,
                error: {
                  code: 'state_write_uncertain' as const,
                  message: 'Fixture lost local commit acknowledgement',
                },
              };
            }

            return result;
          },
        };
        const first = await finishImplementation(f.input, { ...f.deps, state });

        assert.equal(first.outcome, 'uncertain');
        assert.equal(f.inspect().record.phase, 'prepared');

        const next = persisted(await finishImplementation(f.input, f.deps));

        assert.equal(next.record.phase, 'accepted');
        assert.equal(f.remote.pushCalls, 1);
        assert.equal(f.remote.postCalls, 1);
      });
    },
  );
}

await test(
  'uncertain local final acceptance returns the single durable saved review on retry',
  options,
  async () => {
    await fixture(async (f) => {
      const handoffs = {
        ...f.deps.handoffs,
        accept: (input: Parameters<typeof f.deps.handoffs.accept>[0]) => {
          const result = f.deps.handoffs.accept(input);

          assert.equal(result.outcome, 'persisted');

          return {
            schemaVersion: 1 as const,
            outcome: 'uncertain' as const,
            error: {
              code: 'state_write_uncertain' as const,
              message: 'Fixture acceptance acknowledgement lost',
            },
          };
        },
      };
      const first = await finishImplementation(f.input, { ...f.deps, handoffs });

      assert.equal(first.outcome, 'uncertain');

      const second = persisted(await finishImplementation(f.input, f.deps));

      assert.equal(second.record.phase, 'accepted');
      assert.ok(second.record.followUpReview);
      assert.equal(f.remote.pushCalls, 1);
      assert.equal(f.remote.postCalls, 1);
    });
  },
);

await test(
  'offline handoff refuses coordinator ownership conflicts before provider effects',
  options,
  async () => {
    await fixture(async (f) => {
      const ownership = await acquireCoordinatorOwnership(f.context.context.state);

      try {
        const result = await executeLocalHandoff(f.input, {
          mode: 'finish',
          stateDirectory: f.context.context.state,
          gitExecutable: '/not-invoked/git',
          githubExecutable: '/not-invoked/gh',
        });

        assert.ok(
          result.outcome === 'rejected' && result.error.code === 'service_already_running',
          JSON.stringify(result),
        );
        assert.equal(f.remote.pushCalls, 0);
      } finally {
        ownership.release();
      }
    });
  },
);

await test(
  'migration eleven preserves a completed implementation and retained resources before its first publication',
  options,
  async () => {
    await fixture(async (f) => {
      const before = f.deps.runs.inspect(f.job.job.id);
      f.context.context.opened.store.close();
      const raw = new DatabaseSync(join(f.context.context.state, 'state.sqlite'));

      try {
        raw.exec(
          'DROP TABLE implementation_handoffs; DELETE FROM state_migrations WHERE version=11; PRAGMA user_version=10;',
        );
      } finally {
        raw.close();
      }

      const opened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: f.context.context.state,
      });

      assert.ok(opened.outcome === 'opened', JSON.stringify(opened));

      try {
        const after = opened.runs.inspect(f.job.job.id);

        assert.deepEqual(after, before);

        const result = persisted(
          await finishImplementation(f.input, {
            ...f.deps,
            registry: opened.registry,
            worktrees: opened.worktrees,
            state: opened.store,
            runs: opened.runs,
            handoffs: opened.handoffs,
          }),
        );

        assert.equal(result.record.phase, 'accepted');
        assert.equal(f.remote.pushCalls, 1);
        assert.equal(f.remote.postCalls, 1);
      } finally {
        opened.store.close();
      }
    });
  },
);
