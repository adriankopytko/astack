import { configurationDigest } from '../src/core/configuration.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fixture, persisted, type HandoffFixture } from './support/handoff.js';
import { git } from './support/service.js';
import {
  verifyImplementation,
  executeHook,
  finishImplementation,
  reconcileImplementationHandoff,
  openSqliteState,
  nodeProcessRunner,
  verificationWriteResultSchema,
  verificationReadResultSchema,
  hostConfigurationPolicySchema,
  type VerificationDependencies,
  type VerificationRecord,
  type StateWriteResult,
} from '../src/index.js';
const options = { timeout: 180000 };
function saved(result: StateWriteResult<VerificationRecord>) {
  verificationWriteResultSchema.parse(result);

  assert.ok(result.outcome === 'persisted', JSON.stringify(result));

  return result.value;
}

function input(f: HandoffFixture, key = 'verify-explicit') {
  return {
    schemaVersion: 1,
    jobId: f.job.job.id,
    reportId: f.request.reportId,
    key,
    writersExcluded: true,
  };
}

async function run(
  f: HandoffFixture,
  deps: VerificationDependencies = f.verificationDeps,
  key = 'verify-explicit',
) {
  return verifyImplementation(input(f, key), deps);
}

function withProof(f: HandoffFixture, id: string) {
  return {
    ...f.input,
    request: { ...f.request, verification: { source: 'executed' as const, id } },
  };
}

function noWrites(f: HandoffFixture) {
  assert.equal(f.remote.pushCalls, 0);
  assert.equal(f.remote.postCalls, 0);
}

await test(
  'baseline, lane and additional commands execute in two synthetic technology profiles and bind immutable accepted reports',
  options,
  async () => {
    for (const profile of ['node', 'python']) {
      await fixture(
        async (f) => {
          const before = f.deps.runs.inspect(f.job.job.id);
          const seen: string[] = [];
          const deps: VerificationDependencies = {
            ...f.verificationDeps,
            environment: {
              read: async () => ({
                schemaVersion: 1,
                outcome: 'completed',
                value: { CHECK_PROFILE: profile },
              }),
            },
            runner: {
              run: async (...args) => {
                assert.equal(args[0].cwd, f.root);
                assert.deepEqual(args[0].env, { CHECK_PROFILE: profile });

                seen.push(args[0].args.at(-1)!);

                return nodeProcessRunner.run(...args);
              },
            },
          };
          const result = saved(
            await verifyImplementation({ ...input(f), lane: 'full', additional: ['extra'] }, deps),
          );

          assert.equal(result.status, 'passed');
          assert.deepEqual(
            result.checks.map((c) => [c.name, c.kind, c.outcome]),
            [
              ['baseline', 'baseline', 'passed'],
              ['lint', 'lane', 'passed'],
              ['extra', 'additional', 'passed'],
            ],
          );
          assert.equal(seen.length, 3);
          assert.equal(result.source.headCommit, f.head);
          assert.equal(result.source.attemptId, f.job.attempt.id);
          assert.deepEqual(result.artifacts, [f.artifact]);

          const after = f.deps.runs.inspect(f.job.job.id);

          assert.ok(
            before.outcome === 'completed' &&
              before.value &&
              after.outcome === 'completed' &&
              after.value,
          );
          assert.deepEqual(after.value.report, before.value.report);

          noWrites(f);
          const forged = structuredClone(result);
          forged.request.key = 'forged-record';
          forged.id = `verification-${configurationDigest({ jobId: forged.request.jobId, key: forged.request.key })}`;
          forged.status = 'prepared';
          forged.revision = 0;
          forged.verifiedAt = null;
          forged.expiresAt = null;
          forged.checks = forged.checks.slice(1).map((c) => ({
            ...c,
            hookKey: `verify-check-${configurationDigest({ id: forged.id, name: c.name })}`,
            hookId: null,
            hookRevision: null,
            resultDigest: null,
            outcome: 'not_run' as const,
          }));

          assert.equal(f.verificationDeps.verifications.prepare(forged).outcome, 'rejected');

          const published = persisted(await finishImplementation(withProof(f, result.id), f.deps));

          assert.equal(published.record.phase, 'accepted');
          assert.equal(f.remote.pushCalls, 1);
          assert.equal(f.remote.postCalls, 1);
        },
        {
          verify: false,
          configure: (policy) => {
            policy.execution.allowedEnvironment = ['CHECK_PROFILE'];
            const checks = policy.execution.verification!.implementer!;
            checks.lanes = { full: ['lint'] };

            for (const name of ['baseline', 'lint', 'extra']) {
              const command = `${profile}-${name}`;
              policy.execution.commands[command] = {
                executable: process.execPath,
                args: ['-e', `console.log(process.env.CHECK_PROFILE); // ${name}`],
              };
              checks.checks[name] = {
                command,
                timeoutMs: 1000,
                environment: ['CHECK_PROFILE'],
                resources: {},
              };
            }
          },
        },
      );
    }
  },
);
await test(
  'worker/host passed assertions and missing policy cannot authorize a new publication',
  options,
  async () => {
    await fixture(
      async (f) => {
        assert.equal((await run(f)).outcome, 'rejected');

        const fabricated = {
          ...f.input,
          request: {
            ...f.request,
            verification: {
              source: 'host-attestation' as const,
              checks: [
                { name: 'worker says passed', outcome: 'passed' as const, artifact: f.artifact },
              ],
            },
          },
        };
        const rejected = await finishImplementation(fabricated, f.deps);

        assert.ok(
          rejected.outcome === 'rejected' && rejected.error.code === 'verification_blocked',
        );
        assert.equal(
          (
            await verifyImplementation(
              { ...input(f), checks: [{ outcome: 'passed' }] },
              f.verificationDeps,
            )
          ).outcome,
          'rejected',
        );

        noWrites(f);
      },
      {
        verify: false,
        configure: (policy) => {
          delete policy.execution.verification;
        },
      },
    );
  },
);
await test(
  'failed checks preserve not-run checks and repeat keys never execute again',
  options,
  async () => {
    await fixture(
      async (f) => {
        let calls = 0;
        const deps: VerificationDependencies = {
          ...f.verificationDeps,
          runner: {
            run: async (...args) => {
              calls++;

              return nodeProcessRunner.run(...args);
            },
          },
        };
        const record = saved(await run(f, deps));

        assert.equal(record.status, 'failed');
        assert.deepEqual(
          record.checks.map((c) => c.outcome),
          ['failed', 'not_run'],
        );
        assert.equal(calls, 1);
        assert.equal(saved(await run(f, deps)).revision, record.revision);
        assert.equal(calls, 1);
        assert.equal(
          (await finishImplementation(withProof(f, record.id), f.deps)).outcome,
          'rejected',
        );

        noWrites(f);
      },
      {
        verify: false,
        configure: (policy) => {
          policy.execution.commands['fixture-check']!.args = ['-e', 'process.exit(3)'];
          const checks = policy.execution.verification!.implementer!;
          checks.baseline = ['baseline', 'second'];
          checks.checks.second = { ...checks.checks.baseline!, command: 'second-check' };
          policy.execution.commands['second-check'] = {
            executable: process.execPath,
            args: ['--version'],
          };
        },
      },
    );
  },
);
await test(
  'uncertain and cancelled hooks cannot become passed evidence or be repeated automatically',
  options,
  async () => {
    await fixture(
      async (f) => {
        let calls = 0;
        const deps: VerificationDependencies = {
          ...f.verificationDeps,
          runner: {
            run: async () => {
              calls++;

              throw new Error('private diagnostic must not persist');
            },
          },
        };
        const unknown = saved(await run(f, deps));

        assert.equal(unknown.status, 'unknown');
        assert.equal(unknown.checks[0]?.outcome, 'unknown');
        assert.ok(!JSON.stringify(unknown).includes('private diagnostic'));
        assert.equal(saved(await run(f, deps)).id, unknown.id);
        assert.equal(calls, 1);
        assert.equal(
          (await finishImplementation(withProof(f, unknown.id), f.deps)).outcome,
          'rejected',
        );

        noWrites(f);
      },
      { verify: false },
    );
    await fixture(
      async (f) => {
        const controller = new AbortController();
        const deps: VerificationDependencies = {
          ...f.verificationDeps,
          runner: {
            run: async (...args) => {
              const timer = setTimeout(() => controller.abort(), 50);

              try {
                return await nodeProcessRunner.run(...args);
              } finally {
                clearTimeout(timer);
              }
            },
          },
        };
        const cancelled = saved(await verifyImplementation(input(f), deps, controller.signal));

        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.checks[0]?.outcome, 'cancelled');
        assert.equal(
          (await finishImplementation(withProof(f, cancelled.id), f.deps)).outcome,
          'rejected',
        );

        noWrites(f);
      },
      {
        verify: false,
        configure: (policy) => {
          policy.execution.commands['fixture-check']!.args = ['-e', 'setInterval(()=>{},1000)'];
        },
      },
    );
  },
);
await test(
  'zero exit cannot authorize changed HEAD, tracked/untracked files or mutated accepted artifacts',
  options,
  async () => {
    for (const mutation of ['head', 'tracked', 'untracked', 'artifact']) {
      await fixture(
        async (f) => {
          const deps: VerificationDependencies = {
            ...f.verificationDeps,
            runner: {
              run: async (...args) => {
                const result = await nodeProcessRunner.run(...args);

                if (mutation === 'head') {
                  git(f.root, 'commit', '--allow-empty', '-m', 'fixture changed head');
                } else if (mutation === 'tracked') {
                  await writeFile(join(f.root, 'result.txt'), 'changed tracked content');
                } else if (mutation === 'untracked') {
                  await writeFile(join(f.root, 'untracked.txt'), 'preserve generated file');
                } else {
                  await writeFile(join(f.root, f.artifact.path), 'changed ignored artifact');
                }

                return result;
              },
            },
          };
          const record = saved(await run(f, deps));

          assert.notEqual(record.status, 'passed', mutation);
          assert.equal(
            (await finishImplementation(withProof(f, record.id), f.deps)).outcome,
            'rejected',
          );

          noWrites(f);
        },
        { verify: false },
      );
    }
  },
);
await test(
  'expiry and host-policy drift block new publication without mutating historical passed evidence',
  options,
  async () => {
    await fixture(async (f) => {
      assert.ok(f.verification?.expiresAt);

      const opened = await openSqliteState(
        { schemaVersion: 1, stateDirectory: f.context.context.state },
        { now: () => f.verification!.expiresAt! + 1 },
      );

      assert.ok(opened.outcome === 'opened');

      try {
        const result = await finishImplementation(f.input, {
          ...f.deps,
          state: opened.store,
          handoffs: opened.handoffs,
          verifications: opened.verifications,
        });

        assert.ok(result.outcome === 'rejected' && result.error.code === 'verification_blocked');

        const history = opened.verifications.read(f.verification.id);

        assert.ok(history.outcome === 'completed' && history.value?.status === 'passed');

        noWrites(f);
      } finally {
        opened.store.close();
      }
    });
    await fixture(async (f) => {
      const path = join(f.context.context.state, 'config', f.job.job.projectId + '.json');
      const policy = hostConfigurationPolicySchema.parse(JSON.parse(await readFile(path, 'utf8')));
      policy.execution.commands['fixture-check']!.args = ['-e', 'process.exit(0)'];
      await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
      const result = await finishImplementation(f.input, f.deps);

      assert.ok(result.outcome === 'rejected' && result.error.code === 'verification_blocked');

      noWrites(f);
    });
  },
);
await test(
  'verification expiring after push blocks new PR claims while already-claimed PRs reconcile without rerunning checks',
  options,
  async () => {
    await fixture(async (f) => {
      assert.ok(f.verification?.expiresAt);

      let now = Date.now();
      const opened = await openSqliteState(
        { schemaVersion: 1, stateDirectory: f.context.context.state },
        { now: () => now },
      );

      assert.ok(opened.outcome === 'opened');

      const deps = {
        ...f.deps,
        state: opened.store,
        handoffs: opened.handoffs,
        verifications: opened.verifications,
        publisher: {
          ...f.deps.publisher,
          push: async (...args: Parameters<typeof f.deps.publisher.push>) => {
            const result = await f.deps.publisher.push(...args);
            now = f.verification!.expiresAt! + 1;

            return result;
          },
        },
      };

      try {
        const result = await finishImplementation(f.input, deps);

        assert.ok(result.outcome === 'rejected' && result.error.code === 'verification_blocked');
        assert.equal(f.remote.pushCalls, 1);
        assert.equal(f.remote.postCalls, 0);

        const reconciled = persisted(await reconcileImplementationHandoff(f.reconcile, deps));

        assert.equal(reconciled.push.state, 'confirmed');
        assert.equal(reconciled.publication.claim, null);

        const claim = opened.store.claimEffect({
          schemaVersion: 1,
          effectId: reconciled.publication.intent.id,
          owner: 'bypass',
          token: 'bypass',
          leaseMs: 1000,
        });

        assert.ok(claim.outcome === 'rejected' && claim.error.code === 'verification_blocked');
        assert.equal(f.remote.postCalls, 0);
      } finally {
        opened.store.close();
      }
    });
    await fixture(async (f) => {
      f.remote.postMode = 'lost';
      const pending = persisted(await finishImplementation(f.input, f.deps));

      assert.equal(pending.publication.state, 'unknown');
      assert.ok(f.verification?.expiresAt);

      const opened = await openSqliteState(
        { schemaVersion: 1, stateDirectory: f.context.context.state },
        { now: () => f.verification!.expiresAt! + 1 },
      );

      assert.ok(opened.outcome === 'opened');

      try {
        const accepted = persisted(
          await reconcileImplementationHandoff(f.reconcile, {
            ...f.deps,
            state: opened.store,
            handoffs: opened.handoffs,
            verifications: opened.verifications,
          }),
        );

        assert.equal(accepted.record.phase, 'accepted');
        assert.equal(f.remote.postCalls, 1);
      } finally {
        opened.store.close();
      }
    });
  },
);
await test(
  'legacy accepted attestations stay historical reads and the compiled CLI can inspect/reuse saved verification from neutral cwd',
  options,
  async () => {
    await fixture(async (f) => {
      assert.ok(f.verification);

      const path = join(f.context.context.root, 'verification-request.json');
      await writeFile(path, JSON.stringify(f.verification.request));
      const entry = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
      const call = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [entry, '--state-directory', f.context.context.state, 'verification', ...args, '--json'],
          { cwd: f.context.context.root, encoding: 'utf8', timeout: 15000 },
        );
      const inspected = call('inspect', f.verification.id);

      assert.equal(inspected.status, 0, inspected.stderr);

      verificationReadResultSchema.parse(JSON.parse(inspected.stdout));
      const duplicate = call('run', '--file', path);

      assert.equal(duplicate.status, 0, duplicate.stdout || duplicate.stderr);
      assert.equal(
        saved(verificationWriteResultSchema.parse(JSON.parse(duplicate.stdout))).id,
        f.verification.id,
      );

      const published = persisted(await finishImplementation(f.input, f.deps));
      const legacy = {
        ...f.request,
        verification: {
          source: 'host-attestation' as const,
          checks: [{ name: 'historical', outcome: 'passed' as const, artifact: null }],
        },
      };
      const raw = new DatabaseSync(join(f.context.context.state, 'state.sqlite'));

      try {
        raw
          .prepare(
            "UPDATE implementation_handoffs SET data=json_set(data,'$.request.verification',json(?)) WHERE id=?",
          )
          .run(JSON.stringify(legacy.verification), published.record.id);
      } finally {
        raw.close();
      }

      const { verifications: _historicalProof, ...legacyDependencies } = f.deps;
      const historical = persisted(
        await finishImplementation(
          { ...f.input, request: legacy },
          {
            ...legacyDependencies,
            git: { inspect: async () => assert.fail('Historical acceptance must not inspect Git') },
          },
        ),
      );

      assert.equal(historical.record.phase, 'accepted');
      assert.equal(f.remote.pushCalls, 1);
      assert.equal(f.remote.postCalls, 1);
    });
  },
);

await test(
  'a pre-existing reserved check key cannot be recycled into a fresh verification age',
  options,
  async () => {
    await fixture(
      async (f) => {
        const request = input(f, 'preexisting-key');
        const id = `verification-${configurationDigest({ jobId: request.jobId, key: request.key })}`;
        const hookKey = `verify-check-${configurationDigest({ id, name: 'baseline' })}`;
        let calls = 0;
        const deps: VerificationDependencies = {
          ...f.verificationDeps,
          runner: {
            run: async (...args) => {
              calls++;

              return nodeProcessRunner.run(...args);
            },
          },
        };
        const old = await executeHook(
          {
            schemaVersion: 1,
            jobId: f.job.job.id,
            attemptId: f.job.attempt.id,
            key: hookKey,
            phase: 'verify',
            verificationCheck: 'baseline',
            commit: f.head,
            writersExcluded: true,
          },
          deps,
        );

        assert.ok(
          old.outcome === 'persisted' && old.value.status === 'succeeded',
          JSON.stringify(old),
        );

        const result = await verifyImplementation(request, deps);

        assert.ok(
          result.outcome === 'rejected' && result.error.code === 'state_reconciliation_required',
          JSON.stringify(result),
        );
        assert.equal(calls, 1);

        noWrites(f);
      },
      { verify: false },
    );
  },
);
