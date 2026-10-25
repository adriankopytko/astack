import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  observeCi,
  controlCi,
  watchCi,
  openSqliteState,
  ciReadResultSchema,
  ciTickResultSchema,
  ciWriteResultSchema,
  type CiView,
} from '../src/index.js';
import { completed } from '../src/contracts/operation-result.js';
import { fixtureProvider, http, pull } from './support/github.js';
import { fixture, persisted } from './support/ci-review.js';
const options = { timeout: 180000 };

await test(
  'CI schedules preserve missing/pending/failing/skipped/cancelled checks and explicit resumption',
  options,
  async (t) => {
    await fixture(async (f) => {
      let current: CiView | null = null;

      for (const state of ['missing', 'pending', 'fail', 'skipping', 'cancel', 'pass'] as const) {
        await t.test(state, async () => {
          if (current?.record.phase === 'watching') {
            persisted(
              await controlCi(
                {
                  schemaVersion: 1,
                  id: current.record.id,
                  expectedRevision: current.record.revision,
                  action: 'cancel',
                },
                f.ci,
              ),
            );
          }

          f.advance();
          f.snapshot = {
            ...f.snapshot,
            checks: state === 'missing' ? [] : [{ name: 'ci', state }],
          };
          const watched = await f.watch(`gate-${state}`);
          const calls = f.reader.calls;
          const tick = await f.tick();
          ciTickResultSchema.parse(tick);

          assert.equal(tick.outcome, 'completed', JSON.stringify(tick));
          assert.equal(f.reader.calls, calls + 1);

          current = f.savedCi(watched.record.id);
          ciReadResultSchema.parse(completed(current));

          assert.equal(
            current.record.phase,
            ['missing', 'pending'].includes(state)
              ? 'watching'
              : state === 'pass'
                ? 'ready'
                : 'blocked',
          );

          if (current.record.phase === 'watching') {
            assert.equal(
              current.observation.nextRefreshAt,
              f.now +
                Math.ceil(
                  Math.min(
                    f.policy.maxIntervalMs,
                    f.policy.intervalMs * 2 ** watched.observation.backoff,
                  ) * 1.125,
                ),
            );
            assert.equal(current.observation.backoff, watched.observation.backoff + 1);
            assert.equal((await f.tick()).outcome, 'completed');
            assert.equal(f.reader.calls, calls + 1);
          } else {
            f.advance();
            await f.tick();

            assert.equal(f.reader.calls, calls + 1);
          }
        });
      }

      const latest = current as CiView | null;

      assert.ok(latest);

      const resumed = persisted(
        await controlCi(
          {
            schemaVersion: 1,
            id: latest.record.id,
            expectedRevision: latest.record.revision,
            action: 'resume',
          },
          f.ci,
        ),
      );
      ciWriteResultSchema.parse({
        schemaVersion: 1,
        outcome: 'persisted',
        disposition: 'updated',
        value: resumed,
      });
      f.snapshot = { ...f.snapshot, checks: [{ name: 'ci', state: 'pending' }] };
      await f.tick();

      assert.equal(f.savedCi(latest.record.id).record.phase, 'watching');
    });
  },
);

await test(
  'shared targets use one provider read while separate authorized consumers apply independent gates',
  options,
  async () => {
    await fixture(async (f) => {
      const alternate = structuredClone(f.accepted);
      alternate.record.request.key = 'second-authorized-handoff';
      alternate.record.followUpReview!.id = 'second-authorized-follow-up';
      alternate.record.followUpReview!.gate = { requiredChecks: ['other'], overrideReason: null };
      const authority = {
        ...f.ci.handoffs,
        find: (jobId: string, key?: string) =>
          key === 'second-authorized-handoff'
            ? completed(alternate)
            : f.ci.handoffs.find(jobId, key),
      };
      const deps = { ...f.ci, handoffs: authority };
      const first = persisted(await watchCi(f.ciRequest('shared-first'), deps));
      const second = persisted(
        await watchCi(
          {
            ...f.ciRequest('shared-second'),
            source: { kind: 'handoff', jobId: f.f.job.job.id, key: 'second-authorized-handoff' },
          },
          deps,
        ),
      );
      f.snapshot = { ...f.snapshot, checks: [{ name: 'ci', state: 'pass' }] };
      const result = await observeCi({ schemaVersion: 1 }, deps, f.policy);

      assert.equal(result.outcome, 'completed', JSON.stringify(result));
      assert.equal(f.reader.calls, 1);
      assert.equal(first.record.targetId, second.record.targetId);
      assert.equal(f.savedCi(first.record.id).record.phase, 'ready');
      assert.equal(f.savedCi(second.record.id).record.phase, 'watching');
      assert.equal(f.savedCi(second.record.id).record.reason, 'checks_missing');
    });
  },
);

await test(
  'CI rate-limit cooldowns, hard request reservations, deadlines and restart persist without extra reads',
  options,
  async (t) => {
    await fixture(async (f) => {
      let view = await f.watch('rate-budget', 60000);
      f.reader.response = {
        schemaVersion: 1,
        outcome: 'rejected',
        error: { code: 'github_rate_limited', message: 'Synthetic limit', retryAfterMs: 5000 },
      };
      await f.tick();
      view = f.savedCi(view.record.id);

      assert.equal(view.record.phase, 'watching');
      assert.equal(view.observation.nextRefreshAt, f.now + 5000);
      assert.equal(f.reader.calls, 1);

      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: f.f.context.context.state,
      });

      assert.ok(reopened.outcome === 'opened');

      try {
        const deps = { ...f.ci, ci: reopened.ci, runs: reopened.runs, handoffs: reopened.handoffs };
        await observeCi({ schemaVersion: 1 }, deps, f.policy);

        assert.equal(f.reader.calls, 1);

        f.at(view.observation.nextRefreshAt);
        f.reader.response = null;
        await observeCi({ schemaVersion: 1 }, deps, { ...f.policy, requestsPerWindow: 4 });

        assert.equal(
          f.reader.calls,
          1,
          'Already consumed allowance cannot be restored by policy changes.',
        );

        const delayed = f.savedCi(view.record.id);
        f.at(delayed.record.deadlineAt);
        await observeCi({ schemaVersion: 1 }, deps, f.policy);

        assert.equal(f.savedCi(view.record.id).record.phase, 'blocked');
        assert.equal(f.savedCi(view.record.id).record.reason, 'deadline_exceeded');
        assert.equal(f.reader.calls, 1);
      } finally {
        reopened.store.close();
      }

      await t.test('no arbitrary target enrollment', async () => {
        assert.equal(
          (
            await watchCi(
              { schemaVersion: 1, source: { kind: 'pr', target: f.snapshot.target }, key: 'bad' },
              f.ci,
            )
          ).outcome,
          'rejected',
        );
      });
    });
  },
);

await test(
  'CI controls invalidate in-flight results and an expired read claim cannot settle its replacement',
  options,
  async () => {
    await fixture(async (f) => {
      let view = await f.watch('racing-ci');
      f.snapshot = { ...f.snapshot, checks: [{ name: 'ci', state: 'pass' }] };
      f.reader.duringRead = async () => {
        const current = f.savedCi(view.record.id);
        persisted(
          await controlCi(
            {
              schemaVersion: 1,
              id: current.record.id,
              expectedRevision: current.record.revision,
              action: 'suspend',
            },
            f.ci,
          ),
        );
      };

      await f.tick();

      assert.equal(f.savedCi(view.record.id).record.phase, 'suspended');

      f.reader.duringRead = null;
      view = persisted(
        await controlCi(
          {
            schemaVersion: 1,
            id: view.record.id,
            expectedRevision: f.savedCi(view.record.id).record.revision,
            action: 'resume',
          },
          f.ci,
        ),
      );
      const old = persisted(
        f.opened.ci.claim({
          targetId: view.record.targetId,
          owner: 'old',
          token: 'old',
          now: f.now,
          policy: f.policy,
        }),
      );

      assert.ok(old?.claim);

      f.at(old.claim.expiresAt);
      // Give the request an explicit new deadline without altering the existing target claim.
      const updated = persisted(
        await controlCi(
          {
            schemaVersion: 1,
            id: view.record.id,
            expectedRevision: view.record.revision,
            action: 'resume',
          },
          f.ci,
        ),
      );
      const replacement = persisted(
        f.opened.ci.claim({
          targetId: view.record.targetId,
          owner: 'new',
          token: 'new',
          now: f.now,
          policy: f.policy,
        }),
      );

      assert.ok(replacement?.claim);

      const late = f.opened.ci.settle({
        target: { ...old, claim: null, nextRefreshAt: f.now + 1000 },
        owner: 'old',
        token: 'old',
        now: f.now,
        retryNotBefore: null,
        decisions: [],
      });

      assert.ok(late.outcome === 'rejected' && late.error.code === 'state_conflict');
      assert.equal(f.savedCi(updated.record.id).record.phase, 'watching');
    });
  },
);

await test(
  'no-CI readiness requires both saved opt-in and trusted host permission; policy drift blocks',
  options,
  async () => {
    await fixture(async (f) => {
      const path = join(f.f.context.context.state, 'config', `${f.f.job.job.projectId}.json`);
      const original: unknown = JSON.parse(await readFile(path, 'utf8'));
      const policy = original as {
        execution: { review?: { allowGateOverride: boolean; allowNoChecks?: boolean } };
      };
      policy.execution.review = { allowGateOverride: false, allowNoChecks: true };
      await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
      const handoff = f.f.deps.handoffs.find(f.f.job.job.id);

      assert.ok(handoff.outcome === 'completed' && handoff.value?.record.followUpReview);

      const value = structuredClone(handoff.value);
      value.record.followUpReview!.gate = {
        requiredChecks: [],
        overrideReason: null,
        allowNoChecks: true,
      };
      const deps = { ...f.ci, handoffs: { ...f.ci.handoffs, find: () => completed(value) } };
      const watched = persisted(await watchCi(f.ciRequest('no-ci'), deps));
      f.snapshot = { ...f.snapshot, checks: [] };
      await observeCi({ schemaVersion: 1 }, deps, f.policy);

      assert.equal(f.savedCi(watched.record.id).record.phase, 'ready');

      persisted(
        await controlCi(
          {
            schemaVersion: 1,
            id: watched.record.id,
            expectedRevision: f.savedCi(watched.record.id).record.revision,
            action: 'resume',
          },
          deps,
        ),
      );
      policy.execution.review.allowNoChecks = false;
      await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
      const calls = f.reader.calls;
      await observeCi({ schemaVersion: 1 }, deps, f.policy);

      assert.equal(f.savedCi(watched.record.id).record.phase, 'blocked');
      assert.equal(f.reader.calls, calls);
    });
  },
);

for (const mode of ['exact-budget', 'insufficient-budget', 'extra-page'] as const) {
  await test(`GitHub CI transport enforces ${mode} across all bracket and page reads`, async () => {
    const remote = fixtureProvider(
      (request) => {
        const path = request.args.at(-1) ?? '';

        if (path.endsWith('/pulls/12')) {
          return http(pull());
        }

        if (path.includes('check-runs')) {
          const runs =
            mode === 'extra-page' && !path.includes('page=2')
              ? Array.from({ length: 100 }, (_, id) => ({
                  id: id + 1,
                  head_sha: 'a'.repeat(40),
                  name: `check-${id}`,
                  status: 'completed',
                  conclusion: 'success',
                }))
              : [];

          return http({ check_runs: runs });
        }

        return http([]);
      },
      { maxRequests: mode === 'insufficient-budget' ? 3 : 4 },
    );
    const result = await remote.provider.readChecks({
      target: {
        host: 'github.com',
        repository: 'example/project',
        number: 12,
        sha: 'a'.repeat(40),
      },
      root: '/private/fixture',
    });

    assert.equal(result.outcome, mode === 'exact-budget' ? 'completed' : 'rejected');
    assert.equal(remote.calls.length, mode === 'insufficient-budget' ? 3 : 4);

    if (result.outcome === 'rejected') {
      assert.equal(result.error.code, 'github_limit_exceeded');
    }
  });
}

await test(
  'transient failures retain historical snapshots without promoting them to current readiness',
  options,
  async () => {
    await fixture(async (f) => {
      f.snapshot = { ...f.snapshot, checks: [{ name: 'ci', state: 'pass' }] };
      const first = await f.watch('historical-ready');
      await f.tick();
      const positive = f.savedCi(first.record.id);

      assert.equal(positive.record.phase, 'ready');

      const next = await f.watch('must-read-again');
      f.at(next.observation.nextRefreshAt);
      f.reader.response = {
        schemaVersion: 1,
        outcome: 'rejected',
        error: { code: 'github_timed_out', message: 'Synthetic timeout' },
      };
      await f.tick();
      const unknown = f.savedCi(next.record.id);

      assert.equal(unknown.record.phase, 'watching');
      assert.equal(unknown.observation.error, 'github_timed_out');
      assert.deepEqual(unknown.observation.snapshot, positive.observation.snapshot);

      f.at(unknown.observation.nextRefreshAt);
      f.reader.response = null;
      await f.tick();

      assert.equal(f.savedCi(next.record.id).record.phase, 'ready');
    });
  },
);

await test(
  'cancelling a persisted manual review stops its CI consumer before another provider read',
  options,
  async () => {
    await fixture(async (f) => {
      const { submitReview, cancelRun } = await import('../src/index.js');
      const checkout = await f.reviewer();
      const review = persisted(
        await submitReview(
          {
            schemaVersion: 1,
            projectId: f.f.job.job.projectId,
            checkoutId: checkout.checkoutId,
            key: 'manual-ci-wait',
            branch: checkout.branch,
            commit: f.f.head,
            target: f.snapshot.target,
            gate: { requiredChecks: ['ci'], overrideReason: null },
            instructionPaths: ['AGENTS.md'],
            request: {},
          },
          f.reviews,
        ),
      );
      const watched = persisted(
        await watchCi(
          {
            schemaVersion: 1,
            source: { kind: 'review', jobId: review.job.job.id },
            key: 'manual-source',
          },
          f.ci,
        ),
      );
      await f.tick();
      const current = f.savedCi(watched.record.id);
      const count = f.reader.calls;
      const cancelled = await cancelRun(
        { schemaVersion: 1, jobId: review.job.job.id, key: 'stop-review', interrupt: false },
        {
          runs: f.opened.runs,
          workerControl: {
            interrupt: async () => assert.fail('Unstarted review must not interrupt'),
          },
        },
      );

      assert.equal(cancelled.outcome, 'persisted', JSON.stringify(cancelled));

      f.at(current.observation.nextRefreshAt);
      await f.tick();

      assert.equal(f.reader.calls, count);
      assert.equal(f.savedCi(watched.record.id).record.phase, 'cancelled');
    });
  },
);
