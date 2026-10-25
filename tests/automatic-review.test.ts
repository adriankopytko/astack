import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  createServiceCoordinator,
  controlFollowUpReview,
  submitReview,
  openSqliteState,
  dispatchFollowUpReviews,
  followUpWriteResultSchema,
  followUpDispatchResultSchema,
} from '../src/index.js';
import { suspendFollowUpExecutor } from '../src/application/automatic-review.js';
import { fixture, persisted, type CiReviewFixture } from './support/ci-review.js';
const options = { timeout: 240000 };
async function resume(f: CiReviewFixture, id: string) {
  const current = f.savedPlan(id);

  return persisted(
    await controlFollowUpReview(
      { schemaVersion: 1, id, expectedRevision: current.revision, action: 'resume' },
      f.automatic,
    ),
  );
}

async function ready(f: CiReviewFixture, id: string) {
  const dispatched = await f.dispatch();

  assert.equal(dispatched.outcome, 'completed', JSON.stringify(dispatched));

  const ci = f.savedCi(f.savedPlan(id).ciId);
  f.at(Math.max(f.now, ci.observation.nextRefreshAt));
  f.snapshot = {
    ...f.snapshot,
    state: 'OPEN',
    draft: false,
    target: { ...f.snapshot.target, sha: f.f.head },
    checks: [{ name: 'ci', state: 'pass' }],
  };
  const observed = await f.tick();

  assert.equal(observed.outcome, 'completed', JSON.stringify(observed));
  assert.equal(f.savedCi(f.savedPlan(id).ciId).record.phase, 'ready');
}

function coordinator(f: CiReviewFixture, global = 2, sessionId = `auto-verification-${global}`) {
  return createServiceCoordinator({
    sessionId,
    dependencies: f.reviews,
    runtimes: [f.runtime],
    limits: { global, defaultRole: 1, perRole: {} },
    onFailure: () => assert.fail('Coordinator failed'),
  });
}

await test(
  'handoff to pending CI to one independent review requires opt-in, resume, fresh readiness and capacity',
  options,
  async (t) => {
    await fixture(async (f) => {
      const checkout = await f.reviewer();
      let plan = await f.enqueue(checkout);
      followUpWriteResultSchema.parse({
        schemaVersion: 1,
        outcome: 'persisted',
        disposition: 'created',
        value: plan,
      });

      await t.test('manual default creates no watcher', async () => {
        assert.equal(plan.phase, 'suspended');
        assert.equal(f.opened.ci.find(plan.ciId).outcome, 'completed');

        const absent = f.opened.ci.find(plan.ciId);

        assert.ok(absent.outcome === 'completed');
        assert.equal(absent.value, null);
        assert.equal(f.f.context.launches.length, 1);

        await f.enable();
        await f.dispatch();

        assert.equal(f.savedPlan(plan.id).phase, 'suspended');
      });
      plan = await resume(f, plan.id);
      await f.dispatch();
      await f.tick();
      await f.dispatch();

      assert.equal(f.savedPlan(plan.id).phase, 'waiting');
      assert.equal(f.savedPlan(plan.id).reviewJobId, null);
      assert.equal(f.f.context.launches.length, 1);

      const ci = f.savedCi(plan.ciId);
      f.at(ci.observation.nextRefreshAt);
      f.snapshot = { ...f.snapshot, checks: [{ name: 'ci', state: 'pass' }] };
      await f.tick();
      const results = await Promise.all([f.dispatch(), f.dispatch()]);

      for (const result of results) {
        followUpDispatchResultSchema.parse(result);
      }

      plan = f.savedPlan(plan.id);

      assert.equal(plan.phase, 'queued', JSON.stringify(plan));
      assert.ok(plan.reviewJobId);

      const jobId = plan.reviewJobId;
      const queued = f.opened.service.read(jobId);

      assert.ok(queued.outcome === 'completed' && queued.value);
      assert.equal(
        (queued.value.job.intent.task as { authorization: string }).authorization,
        'after-handoff',
      );

      const limited = coordinator(f, 1);
      limited.start();

      try {
        await limited.idle();
      } finally {
        await limited.stop();
      }

      assert.equal(
        f.f.context.launches.length,
        1,
        'Retained implementation capacity must block new dispatch.',
      );
      assert.equal(f.savedPlan(plan.id).phase, 'queued');

      const running = coordinator(f);
      const competing = coordinator(f, 2, 'auto-verification-competing');
      running.start();
      competing.start();

      try {
        await Promise.all([running.idle(), competing.idle()]);

        assert.equal(f.f.context.launches.length, 2);
        assert.equal(f.savedPlan(plan.id).phase, 'dispatched');

        const job = f.opened.service.read(jobId);

        assert.ok(job.outcome === 'completed' && job.value);
        assert.equal(job.value.entry.state, 'started');
        assert.ok(f.f.context.prompts.at(-1)?.text.startsWith('# Review assignment v4'));

        const prompts = f.f.context.prompts.length;
        await f.enable(false);
        running.wake();
        await running.idle();
        await f.dispatch();

        assert.equal(f.f.context.launches.length, 2);
        assert.equal(f.f.context.prompts.length, prompts);
        assert.equal(f.savedPlan(plan.id).phase, 'dispatched');

        const { acceptRunReport, nodeRunArtifactReader } = await import('../src/index.js');
        const { reviewTaskSchema } = await import('../src/contracts/review-task.js');
        const task = reviewTaskSchema.parse(job.value.job.intent.task);
        const completed = persisted(
          await acceptRunReport(
            {
              schemaVersion: 1,
              jobId,
              key: 'review-completion-after-disable',
              proposal: {
                schemaVersion: 1,
                jobId,
                attemptId: job.value.attempt.id,
                projectId: job.value.job.projectId,
                checkoutId: job.value.job.checkoutId,
                target: task.submission.target,
                outcome: 'reviewed',
                summary: 'Controlled review completed after future automation was disabled.',
                findings: [],
                blockers: [],
                gate: task.submission.gate,
                acceptanceSnapshot: task.initialSnapshot,
                currentSnapshot: null,
              },
            },
            {
              ...f.reviews,
              runs: f.opened.runs,
              artifacts: nodeRunArtifactReader,
              workerInput: f.f.context.workerInput,
              workerControl: { interrupt: async () => assert.fail('Report must not interrupt') },
            },
          ),
        );

        assert.equal(completed.status, 'completed');
        assert.equal(
          (
            await controlFollowUpReview(
              {
                schemaVersion: 1,
                id: plan.id,
                expectedRevision: f.savedPlan(plan.id).revision,
                action: 'resume',
              },
              f.automatic,
            )
          ).outcome,
          'rejected',
        );
      } finally {
        await Promise.all([running.stop(), competing.stop()]);
      }
    });
  },
);

await test(
  'disable during fresh acceptance or capacity preflight cannot dispatch, and manual review still works',
  options,
  async (t) => {
    await fixture(async (f) => {
      await f.enable();
      let plan = await f.enqueue(await f.reviewer());
      await ready(f, plan.id);
      f.reader.duringTarget = async () => {
        f.reader.duringTarget = null;
        await f.enable(false);
      };

      await f.dispatch();
      plan = f.savedPlan(plan.id);

      assert.equal(plan.phase, 'suspended');
      assert.equal(plan.reviewJobId, null);
      assert.equal(f.f.context.launches.length, 1);

      await f.enable();
      await resume(f, plan.id);
      await ready(f, plan.id);
      await f.dispatch();
      plan = f.savedPlan(plan.id);

      assert.equal(plan.phase, 'queued', JSON.stringify(plan));
      assert.ok(plan.reviewJobId);

      f.reader.duringTarget = async () => {
        f.reader.duringTarget = null;
        await f.enable(false);
      };

      const running = coordinator(f);
      running.start();

      try {
        await running.idle();
        const blocked = f.opened.service.read(plan.reviewJobId);

        assert.ok(blocked.outcome === 'completed' && blocked.value);
        assert.equal(blocked.value.entry.claim, null);
        assert.equal(f.f.context.launches.length, 1);
        assert.equal(f.savedPlan(plan.id).phase, 'suspended');

        await t.test('manual request does not alias the paused automatic job', async () => {
          const checkout = await f.reviewer();
          const manual = persisted(
            await submitReview(
              {
                schemaVersion: 1,
                projectId: f.f.job.job.projectId,
                checkoutId: checkout.checkoutId,
                key: 'explicit-manual',
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

          assert.notEqual(manual.job.job.id, plan.reviewJobId);
          assert.equal(manual.assignment.authorization, 'manual-request');

          running.wake();
          await running.idle();

          assert.equal(f.f.context.launches.length, 2);
          assert.equal(f.savedPlan(plan.id).phase, 'suspended');
        });
      } finally {
        await running.stop();
      }
    });
  },
);

await test(
  'disable at CI enrollment is transactional and does not leave an owned watcher running',
  options,
  async () => {
    await fixture(async (f) => {
      await f.enable();
      const plan = await f.enqueue(await f.reviewer());
      const original = f.ci.configuration;
      let disabled = false;
      f.ci.configuration = {
        ...original,
        async readPolicy(projectId, signal) {
          if (!disabled) {
            disabled = true;
            await f.enable(false);
          }

          return original.readPolicy(projectId, signal);
        },
      };
      await f.dispatch();
      const ci = f.opened.ci.find(plan.ciId);

      assert.ok(ci.outcome === 'completed');
      assert.equal(ci.value, null);
      assert.equal(f.savedPlan(plan.id).phase, 'suspended');
      assert.equal(f.reader.calls, 0);

      await f.enable();
      await f.dispatch();

      assert.equal(
        f.savedPlan(plan.id).phase,
        'suspended',
        'Enable alone must not resume backlog.',
      );
    });
  },
);

await test(
  'closed/stale targets and an interrupted queue-link transaction preserve intent without a duplicate job',
  options,
  async (t) => {
    await fixture(async (f) => {
      await f.enable();
      const plan = await f.enqueue(await f.reviewer());

      for (const mode of ['closed', 'stale', 'failed-check', 'link-rollback'] as const) {
        await t.test(mode, async () => {
          if (f.savedPlan(plan.id).phase === 'blocked') {
            await resume(f, plan.id);
          }

          await ready(f, plan.id);
          const raw = new DatabaseSync(join(f.f.context.context.state, 'state.sqlite'));

          try {
            if (mode === 'link-rollback') {
              raw.exec(
                "CREATE TRIGGER reject_follow_up_link BEFORE INSERT ON run_events WHEN json_extract(NEW.data,'$.kind')='follow_up_queued' BEGIN SELECT RAISE(ABORT,'fixture queue-link failure'); END;",
              );
            } else {
              f.reader.duringTarget = async () => {
                f.reader.duringTarget = null;
                f.snapshot =
                  mode === 'closed'
                    ? { ...f.snapshot, state: 'CLOSED' }
                    : mode === 'stale'
                      ? { ...f.snapshot, target: { ...f.snapshot.target, sha: 'f'.repeat(40) } }
                      : { ...f.snapshot, checks: [{ name: 'ci', state: 'fail' }] };
              };
            }

            await f.dispatch();
            const result = f.savedPlan(plan.id);

            assert.equal(result.phase, 'blocked', JSON.stringify(result));
            assert.equal(result.reviewJobId, null);
            assert.equal(
              raw
                .prepare("SELECT COUNT(*) AS count FROM jobs WHERE operation='delegate:reviewer'")
                .get()?.count,
              0,
            );
            assert.equal(
              raw.prepare('SELECT COUNT(*) AS count FROM review_requests').get()?.count,
              0,
            );
            assert.equal(f.f.context.launches.length, 1);
          } finally {
            if (mode === 'link-rollback') {
              raw.exec('DROP TRIGGER reject_follow_up_link');
            }

            raw.close();
          }
        });
      }

      await resume(f, plan.id);
      await ready(f, plan.id);
      await f.dispatch();

      assert.equal(f.savedPlan(plan.id).phase, 'queued');
      assert.ok(f.savedPlan(plan.id).reviewJobId);
    });
  },
);

await test(
  'restart without executor suspends queued work and explicit resume reuses the same accepted job',
  options,
  async () => {
    await fixture(async (f) => {
      await f.enable();
      let plan = await f.enqueue(await f.reviewer());
      await ready(f, plan.id);
      await f.dispatch();
      plan = f.savedPlan(plan.id);

      assert.equal(plan.phase, 'queued');
      assert.ok(plan.reviewJobId);

      const jobId = plan.reviewJobId;
      const opened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: f.f.context.context.state,
      });

      assert.ok(opened.outcome === 'opened');

      try {
        assert.equal(
          (await suspendFollowUpExecutor(opened.automaticReviews, () => f.now)).outcome,
          'completed',
        );

        const restarted = {
          ...f.automatic,
          store: opened.automaticReviews,
          reviews: {
            ...f.reviews,
            queue: opened.service,
            automaticReviews: opened.automaticReviews,
          },
          ci: {
            ...f.ci,
            ci: opened.ci,
            handoffs: opened.handoffs,
            runs: opened.runs,
            automaticCi: opened.automaticReviews,
          },
        };
        await dispatchFollowUpReviews(restarted);

        assert.equal(f.savedPlan(plan.id).phase, 'suspended');
        assert.equal(f.savedPlan(plan.id).reviewJobId, jobId);

        const current = f.savedPlan(plan.id);
        persisted(
          await controlFollowUpReview(
            { schemaVersion: 1, id: plan.id, expectedRevision: current.revision, action: 'resume' },
            restarted,
          ),
        );
        await ready(f, plan.id);
        await dispatchFollowUpReviews(restarted);

        assert.equal(f.savedPlan(plan.id).phase, 'queued');
        assert.equal(f.savedPlan(plan.id).reviewJobId, jobId);
        assert.equal(f.f.context.launches.length, 1);
      } finally {
        opened.store.close();
      }
    });
  },
);

async function nativeSetup(f: CiReviewFixture) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { hostConfigurationPolicySchema, configureHerdrProject } = await import('../src/index.js');
  const { fakeProvider } = await import('./support/herdr.js');
  const path = join(f.f.context.context.state, 'config', `${f.f.job.job.projectId}.json`);
  const policy = hostConfigurationPolicySchema.parse(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
  const args = [
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'on-request',
    '--no-daemon',
    '--no-alt-screen',
  ];
  policy.project.roles = {
    ...policy.project.roles,
    reviewer: { runtime: 'codex-herdr', command: 'native-review' },
  };
  policy.execution.allowedRuntimes.push('codex-herdr');
  policy.execution.commands['native-review'] = { executable: process.execPath, args };
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  const fake = fakeProvider();
  const calls: string[] = [];
  let sequence = 0;
  const deps: import('../src/index.js').RuntimeDependencies = {
    ...f.reviews,
    state: f.opened.store,
    herdr: f.opened.herdr,
    runtime: f.opened.runtime,
    provider: fake.provider,
    allowAutomaticReview: true,
    canonicalCodexExecutable: process.execPath,
    newId: () => `native-test-${++sequence}`,
    worker: {
      async launch({ space, args: actual }) {
        calls.push('launch');

        assert.deepEqual(actual, args);
        assert.ok(space.handle);

        fake.snapshot(space.target).agents.push({
          ...space.handle,
          name: space.expectedAgentName,
          kind: 'codex',
          nativeSessionId: 'native-test',
          cwd: space.root,
          foregroundCwd: space.root,
          status: 'idle',
        });

        return { schemaVersion: 1, outcome: 'completed', value: null };
      },
      async input() {
        calls.push('input');

        return { schemaVersion: 1, outcome: 'completed', value: null };
      },
      async interrupt() {
        calls.push('interrupt');

        return { schemaVersion: 1, outcome: 'completed', value: null };
      },
    },
  };
  const configured = await configureHerdrProject(
    {
      schemaVersion: 1,
      projectId: f.f.job.job.projectId,
      target: { session: 'native-test', socketPath: join(f.f.context.context.root, 'native.sock') },
      label: 'Fixture',
    },
    deps,
  );

  assert.equal(configured.outcome, 'persisted', JSON.stringify(configured));

  await f.enable();
  const plan = await f.enqueue(await f.reviewer());
  await ready(f, plan.id);
  await f.dispatch();
  const queued = f.savedPlan(plan.id);

  assert.ok(queued.reviewJobId);

  const job = persisted(
    f.opened.service.claim({
      jobId: queued.reviewJobId,
      owner: 'native-test',
      token: 'native-test-claim',
      now: f.now,
      limits: { global: 2, defaultRole: 1, perRole: {} },
    }),
  );

  assert.ok(job);

  return {
    deps,
    calls,
    job,
    plan,
    disable() {
      const settings = f.opened.automaticReviews.settings(plan.projectId);

      assert.ok(settings.outcome === 'completed');

      persisted(
        f.opened.automaticReviews.configure({
          projectId: plan.projectId,
          expectedRevision: settings.value.revision,
          enabled: false,
          now: f.now,
        }),
      );
    },
  };
}

await test(
  'native automatic launch requires host capability and SQL authorization at reservation',
  options,
  async () => {
    await fixture(async (f) => {
      const { launchRuntime } = await import('../src/index.js');
      const native = await nativeSetup(f);
      const request = { schemaVersion: 1, attemptId: native.job.attempt.id };
      const disabled = await launchRuntime(request, {
        ...native.deps,
        allowAutomaticReview: false,
      });

      assert.ok(
        disabled.outcome === 'rejected' && disabled.error.code === 'automatic_review_blocked',
      );

      const result = await launchRuntime(request, {
        ...native.deps,
        runtime: {
          ...native.deps.runtime,
          reserve(session) {
            native.disable();

            return native.deps.runtime.reserve(session);
          },
        },
      });

      assert.ok(
        result.outcome === 'rejected' && result.error.code === 'automatic_review_blocked',
        JSON.stringify(result),
      );
      assert.deepEqual(native.calls, []);

      const saved = f.opened.runtime.read(native.job.attempt.id);

      assert.ok(saved.outcome === 'completed');
      assert.equal(saved.value, null);
    });
  },
);

await test(
  'native initial-input disable race preserves the idle worker and still allows explicit interruption',
  options,
  async () => {
    await fixture(async (f) => {
      const { launchRuntime, inputRuntime, interruptRuntime } = await import('../src/index.js');
      const { renderReviewPrompt } = await import('../src/core/review-prompt.js');
      const { reviewTaskSchema } = await import('../src/contracts/review-task.js');
      const native = await nativeSetup(f);
      const request = { schemaVersion: 1, attemptId: native.job.attempt.id };
      const launched = await launchRuntime(request, native.deps);

      assert.ok(
        launched.outcome === 'completed' && launched.value.state === 'running',
        JSON.stringify(launched),
      );

      const text = renderReviewPrompt(
        native.job,
        reviewTaskSchema.parse(native.job.job.intent.task),
      );
      const result = await inputRuntime(
        { ...request, key: 'review:initial:v1', text },
        {
          ...native.deps,
          runtime: {
            ...native.deps.runtime,
            reserveAction(session, action) {
              native.disable();

              return native.deps.runtime.reserveAction(session, action);
            },
          },
        },
      );

      assert.ok(
        result.outcome === 'rejected' && result.error.code === 'automatic_review_blocked',
        JSON.stringify(result),
      );
      assert.deepEqual(native.calls, ['launch']);

      const pending = f.opened.runtime.pending(native.job.attempt.id);

      assert.ok(pending.outcome === 'completed');
      assert.equal(pending.value, null);

      const interrupted = await interruptRuntime({ ...request, key: 'explicit-stop' }, native.deps);

      assert.ok(interrupted.outcome === 'completed', JSON.stringify(interrupted));
      assert.deepEqual(native.calls, ['launch', 'interrupt']);
    });
  },
);

await test(
  'the opted-in local service wakes from shared CI readiness and dispatches without manual ticks',
  options,
  async () => {
    await fixture(async (f) => {
      const { startLocalService, requestLocalService } = await import('../src/index.js');
      const { gitPath } = await import('./support/service.js');
      await f.enable();
      const plan = await f.enqueue(await f.reviewer());
      let reads = 0;
      const started = await startLocalService(
        {
          schemaVersion: 1,
          stateDirectory: f.f.context.context.state,
          gitExecutable: gitPath,
          limits: { global: 2, defaultRole: 1, perRole: {} },
        },
        {
          afterHandoffReview: true,
          ci: {
            policy: f.policy,
            reader: {
              async read() {
                reads++;

                return {
                  schemaVersion: 1,
                  outcome: 'completed',
                  value: { ...f.snapshot, observedAt: Date.now() },
                };
              },
            },
          },
          reviewTargets: {
            async read() {
              return {
                schemaVersion: 1,
                outcome: 'completed',
                value: { ...f.snapshot, observedAt: Date.now() },
              };
            },
          },
          runtimes: [f.runtime],
          runWorkerInput: f.f.context.workerInput,
        },
      );

      assert.ok(started.outcome === 'listening', JSON.stringify(started));

      const until = async (predicate: () => boolean) => {
        const end = Date.now() + 45000;

        while (!predicate()) {
          assert.ok(
            Date.now() < end,
            'Service did not reach its expected durable state within the bounded wait.',
          );

          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      };

      try {
        await until(() => reads > 0);

        assert.equal(f.f.context.launches.length, 1);
        assert.equal(f.savedPlan(plan.id).phase, 'waiting');

        f.snapshot = { ...f.snapshot, checks: [{ name: 'ci', state: 'pass' }] };
        const wake = await requestLocalService(started.stateDirectory, {
          schemaVersion: 1,
          operation: 'ci_wake',
        });

        assert.ok(wake.outcome === 'completed');

        await until(
          () => f.savedPlan(plan.id).phase === 'dispatched' && f.f.context.launches.length === 2,
        );
        const linked = f.savedPlan(plan.id);

        assert.ok(linked.reviewJobId);

        const job = f.opened.service.read(linked.reviewJobId);

        assert.ok(job.outcome === 'completed' && job.value?.entry.claim);
        assert.equal(
          job.value.job.intent.task &&
            (job.value.job.intent.task as { authorization: string }).authorization,
          'after-handoff',
        );
      } finally {
        const closed = await started.close();

        assert.equal(closed.outcome, 'completed', JSON.stringify(closed));
      }
    });
  },
);
