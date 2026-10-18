import { renderReviewPrompt } from '../src/core/review-prompt.js';
import { reviewTaskSchema } from '../src/contracts/review-task.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  submitReview,
  inspectReview,
  createReviewRuntime,
  createServiceCoordinator,
  reviewSubmitRequestSchema,
  reviewSubmitResultSchema,
  reviewWorkerReportSchema,
  prepareWorktree,
  createWorktreeGit,
  nodeProcessRunner,
  submitImplementation,
  startLocalService,
  requestLocalService,
  type ReviewDependencies,
  type ReviewSnapshot,
  type ReviewJob,
  type StateWriteResult,
} from '../src/index.js';
import { completed } from '../src/contracts/operation-result.js';
import { fixture } from './support/implementation.js';
import { gitPath } from './support/service.js';

const options = { timeout: 90000 };
type Context = Parameters<Parameters<typeof fixture>[0]>[0];
function accepted(result: StateWriteResult<ReviewJob>): ReviewJob {
  reviewSubmitResultSchema.parse(result);

  if (result.outcome !== 'persisted') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

async function requestFor(context: Context) {
  const {
    description: _description,
    acceptanceCriteria: _criteria,
    ...base
  } = await context.prepare();

  return reviewSubmitRequestSchema.parse({
    ...base,
    target: { host: 'github.com', repository: 'example/project', number: 12, sha: base.commit },
  });
}

function dependencies(context: Context, request: Awaited<ReturnType<typeof requestFor>>) {
  let snapshot: ReviewSnapshot = {
    target: request.target,
    baseSha: request.commit,
    state: 'OPEN',
    draft: false,
    sourceRepository: 'contributor/fork',
    checks: [{ name: 'test', state: 'pass' }],
    observedAt: 100,
  };
  let reads = 0;
  const deps: ReviewDependencies = {
    ...context.deps,
    targets: {
      async read() {
        reads++;

        return completed(structuredClone(snapshot));
      },
    },
  };
  const runtime = createReviewRuntime({
    runtime: context.runtime,
    dependencies: deps,
    workerInput: context.workerInput,
  });
  const coordinator = createServiceCoordinator({
    sessionId: 'review-service',
    limits: { global: 1, defaultRole: 1, perRole: {} },
    dependencies: deps,
    runtimes: [runtime],
    onFailure: () => assert.fail('Fixture coordinator failed'),
  });

  return {
    deps,
    runtime,
    coordinator,
    snapshot: () => snapshot,
    change: (value: ReviewSnapshot) => {
      snapshot = value;
    },
    reads: () => reads,
  };
}

async function another(
  context: Context,
  request: Awaited<ReturnType<typeof requestFor>>,
  key: string,
) {
  const prepared = await prepareWorktree(
    {
      schemaVersion: 1,
      projectId: request.projectId,
      key,
      branch: `refs/heads/${key}`,
      baseCommit: request.commit,
    },
    {
      ...context.context.deps,
      store: context.deps.worktrees,
      files: context.deps.files,
      managedRoot: join(context.context.state, 'worktrees'),
      effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
      nextId: (kind) => `${kind}-${key}`,
    },
  );

  assert.ok('record' in prepared && prepared.record.phase === 'ready', JSON.stringify(prepared));

  return {
    ...request,
    key,
    checkoutId: prepared.record.intent.checkoutId,
    branch: prepared.record.intent.branch,
  };
}

function saved(id: string, deps: ReviewDependencies) {
  const result = inspectReview({ schemaVersion: 1, jobId: id }, deps);

  assert.ok(result.outcome === 'completed' && result.value, JSON.stringify(result));

  return result.value;
}

await test(
  'manual external PR review records exact target, authorization, source and dedicated attempt without launching',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const job = accepted(await submitReview(request, state.deps));

      assert.equal(job.assignment.promptVersion, 2);

      const { promptVersion: _version, ...legacy } = job.assignment;
      const oldPrompt = renderReviewPrompt(job.job, reviewTaskSchema.parse(legacy));
      const explicitOldPrompt = renderReviewPrompt(job.job, { ...legacy, promptVersion: 1 });
      const newPrompt = renderReviewPrompt(job.job, job.assignment);
      const example = (prompt: string) =>
        JSON.parse(prompt.split('\n').at(-2) ?? '') as { acceptanceSnapshot: unknown };

      assert.equal(oldPrompt, explicitOldPrompt);
      assert.equal(example(oldPrompt).acceptanceSnapshot, '<copy the acceptance snapshot above>');
      assert.deepEqual(example(newPrompt).acceptanceSnapshot, job.assignment.initialSnapshot);
      assert.notEqual(newPrompt, oldPrompt);
      assert.equal(job.assignment.authorization, 'manual-request');
      assert.equal(job.assignment.initialSnapshot.sourceRepository, 'contributor/fork');
      assert.equal(job.job.entry.role, 'reviewer');
      assert.equal(job.review.acceptedOutcome, null);
      assert.ok(job.job.job.configuration);
      assert.equal(context.launches.length, 0);
      assert.equal(context.prompts.length, 0);
      assert.equal(
        accepted(
          await submitReview(request, {
            ...state.deps,
            targets: { read: async () => assert.fail('Idempotent retry must be offline') },
          }),
        ).job.attempt.id,
        job.job.attempt.id,
      );

      const changed = await submitReview(
        { ...request, target: { ...request.target, number: 13 } },
        state.deps,
      );

      assert.equal(changed.outcome, 'rejected');
    });
  },
);
await test(
  'different request keys for the same PR/SHA reuse atomically and retain alias idempotency',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const sibling = await another(context, request, 'other-review');
      const [first, second] = await Promise.all([
        submitReview(request, state.deps),
        submitReview(sibling, state.deps),
      ]);
      const a = accepted(first);
      const b = accepted(second);

      assert.equal(a.job.job.id, b.job.job.id);
      assert.notEqual(
        first.outcome === 'persisted' && first.disposition,
        second.outcome === 'persisted' && second.disposition,
      );
      assert.equal(accepted(await submitReview(sibling, state.deps)).job.job.id, a.job.job.id);

      const conflict = await submitReview(
        { ...sibling, gate: { requiredChecks: ['different'], overrideReason: null } },
        state.deps,
      );

      assert.equal(conflict.outcome, 'rejected');

      const repeated = accepted(
        await submitReview(
          { ...(await another(context, request, 'repeat-review')), repeat: true },
          state.deps,
        ),
      );

      assert.notEqual(repeated.job.attempt.id, a.job.attempt.id);
      assert.notEqual(repeated.job.job.checkoutId, a.job.job.checkoutId);

      const shared = await submitReview(
        { ...a.assignment.submission, key: 'repeat-shared', repeat: true },
        state.deps,
      );

      assert.equal(shared.outcome, 'rejected');
    });
  },
);
await test(
  'review and implementation never share an owned checkout, in either submission order',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      accepted(await submitReview(request, state.deps));
      const {
        target: _firstTarget,
        gate: _firstGate,
        repeat: _firstRepeat,
        resources: _firstResources,
        ...firstBase
      } = request;
      const implementation = await submitImplementation(
        { ...firstBase, description: 'Implement', acceptanceCriteria: [] },
        state.deps,
      );

      assert.equal(implementation.outcome, 'rejected');

      const {
        target: _target,
        gate: _gate,
        repeat: _repeat,
        resources: _resources,
        ...base
      } = await another(context, request, 'implementation-first');
      const implemented = await submitImplementation(
        { ...base, description: 'Implement', acceptanceCriteria: [] },
        state.deps,
      );

      assert.equal(implemented.outcome, 'persisted');

      const review = await submitReview({ ...request, ...base, repeat: true }, state.deps);

      assert.equal(review.outcome, 'rejected');
    });
  },
);
await test(
  'pending CI queues, explicit wake launches static review once, and restart never duplicates prompt delivery',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      state.snapshot().checks[0]!.state = 'pending';
      const job = accepted(await submitReview(request, state.deps));
      state.coordinator.start();
      await state.coordinator.idle();

      assert.equal(context.launches.length, 0);
      assert.equal(
        saved(job.job.job.id, state.deps).job.entry.readiness?.message,
        'checks_not_passing',
      );

      state.snapshot().checks[0]!.state = 'pass';
      state.coordinator.wake();
      await state.coordinator.idle();

      assert.equal(context.launches.length, 1);
      assert.equal(context.prompts.length, 1);
      assert.match(context.prompts[0]!.text, /Manual review assignment/);
      assert.match(context.prompts[0]!.text, /"state":"pending"/);
      assert.equal(saved(job.job.job.id, state.deps).review.delivery, 'acknowledged');

      await state.coordinator.stop();
      const restarted = dependencies(context, request);
      restarted.coordinator.start();
      await restarted.coordinator.idle();
      await restarted.coordinator.stop();

      assert.equal(context.launches.length, 1);
      assert.equal(context.prompts.length, 1);
    });
  },
);
await test(
  'full head changes block before launch and surface stale evidence after delivery without retargeting',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const job = accepted(await submitReview(request, state.deps));
      state.change({ ...state.snapshot(), target: { ...request.target, sha: 'f'.repeat(40) } });
      state.coordinator.start();
      await state.coordinator.idle();

      assert.equal(context.launches.length, 0);
      assert.equal(
        saved(job.job.job.id, state.deps).job.entry.readiness?.code,
        'review_target_changed',
      );

      state.change({ ...state.snapshot(), target: request.target });
      state.coordinator.wake();
      await state.coordinator.idle();
      state.change({ ...state.snapshot(), target: { ...request.target, sha: 'e'.repeat(40) } });
      state.coordinator.wake();
      await state.coordinator.idle();
      const view = saved(job.job.job.id, state.deps);

      assert.equal(view.review.state, 'needs_decision');
      assert.equal(view.review.reason, 'review_target_changed');
      assert.equal(view.assignment.submission.target.sha, request.commit);
      assert.equal(context.prompts.length, 1);

      context.modes.runtime = 'unknown';
      state.coordinator.wake();
      await state.coordinator.idle();
      await state.coordinator.stop();
      const uncertain = saved(job.job.job.id, state.deps);

      assert.equal(uncertain.review.state, 'unknown');
      assert.deepEqual(uncertain.job.entry.observation?.evidence.reviewFreshness, {
        reason: 'review_target_changed',
      });
    });
  },
);
await test(
  'CI override requires trusted permission, records failing checks, and never overrides head mismatch',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const override = {
        ...request,
        gate: { requiredChecks: [], overrideReason: 'Review now while CI is red' },
      };
      state.snapshot().checks[0]!.state = 'fail';

      assert.equal((await submitReview(override, state.deps)).outcome, 'rejected');

      const policyPath = join(context.context.state, 'config', `${request.projectId}.json`);
      const policy = JSON.parse(await readFile(policyPath, 'utf8')) as {
        execution: Record<string, unknown>;
      };
      policy.execution.review = { allowGateOverride: true };
      await writeFile(policyPath, JSON.stringify(policy));
      const job = accepted(await submitReview(override, state.deps));
      state.coordinator.start();
      await state.coordinator.idle();
      await state.coordinator.stop();

      assert.equal(context.prompts.length, 1);
      assert.equal(job.assignment.initialSnapshot.checks[0]!.state, 'fail');
      assert.equal(saved(job.job.job.id, state.deps).review.state, 'started');
    });
  },
);
await test(
  'missing checks, selected names, draft PRs and isolated integration resources expose blockers without launching',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const job = accepted(await submitReview({ ...request, resources: ['database'] }, state.deps));
      state.coordinator.start();
      await state.coordinator.idle();
      await state.coordinator.stop();

      assert.match(
        saved(job.job.job.id, state.deps).job.entry.readiness?.message ?? '',
        /provisioning/,
      );
      assert.equal(context.launches.length, 0);
      assert.equal(context.prompts.length, 0);
    });
  },
);
await test(
  'occupied capacity retains a second explicit review without launching or borrowing resources',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const first = accepted(await submitReview(request, state.deps));
      const second = accepted(
        await submitReview(
          { ...(await another(context, request, 'second-review')), repeat: true },
          state.deps,
        ),
      );
      state.coordinator.start();
      await state.coordinator.idle();
      await state.coordinator.stop();

      assert.equal(context.launches.length, 1);
      assert.equal(saved(first.job.job.id, state.deps).review.state, 'started');
      assert.equal(saved(second.job.job.id, state.deps).review.state, 'queued');
    });
  },
);
await test(
  'review report proposals preserve exact SHA and gate evidence without accepting task success',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const job = accepted(await submitReview(request, state.deps));
      const report = {
        schemaVersion: 1,
        jobId: job.job.job.id,
        attemptId: job.job.attempt.id,
        projectId: request.projectId,
        checkoutId: request.checkoutId,
        target: request.target,
        outcome: 'reviewed',
        summary: 'Reviewed static diff',
        findings: [],
        blockers: [],
        gate: request.gate,
        acceptanceSnapshot: state.snapshot(),
        currentSnapshot: null,
      };

      assert.equal(reviewWorkerReportSchema.safeParse(report).success, true);
      assert.equal(
        reviewWorkerReportSchema.safeParse({
          ...report,
          target: { ...request.target, sha: 'f'.repeat(40) },
        }).success,
        false,
      );
      assert.equal(saved(job.job.job.id, state.deps).review.acceptedOutcome, null);
    });
  },
);

await test(
  'local RPC accepts an explicit review and offline inspection preserves its durable receipt',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const service = await startLocalService(
        { schemaVersion: 1, stateDirectory: context.context.state, gitExecutable: gitPath },
        { reviewTargets: state.deps.targets },
      );

      assert.equal(service.outcome, 'listening', JSON.stringify(service));

      if (service.outcome !== 'listening') {
        return;
      }

      try {
        const result = await requestLocalService(context.context.state, {
          ...request,
          operation: 'review_submit',
        });

        assert.ok(
          result.outcome === 'persisted' && 'review' in result.value,
          JSON.stringify(result),
        );

        const jobId = result.value.job.job.id;
        const repeated = await requestLocalService(context.context.state, {
          ...request,
          operation: 'review_submit',
        });

        assert.ok(repeated.outcome === 'persisted' && repeated.disposition === 'existing');

        await service.close();

        assert.equal(saved(jobId, state.deps).assignment.submission.target.sha, request.commit);
      } finally {
        await service.close();
      }
    });
  },
);

await test(
  'lost review input acknowledgement retains unknown state and never sends the initial review twice',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      context.modes.input = 'lost';
      const job = accepted(await submitReview(request, state.deps));
      state.coordinator.start();
      await state.coordinator.idle();

      assert.equal(saved(job.job.job.id, state.deps).review.delivery, 'pending');

      state.coordinator.wake();
      await state.coordinator.idle();
      await state.coordinator.stop();

      assert.equal(saved(job.job.job.id, state.deps).review.state, 'unknown');
      assert.equal(context.launches.length, 1);
      assert.equal(context.prompts.length, 1);
    });
  },
);
await test(
  'a base change between preflight and first delivery preserves the worker but blocks input',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await requestFor(context);
      const state = dependencies(context, request);
      const job = accepted(await submitReview(request, state.deps));
      const start = context.base.start.bind(context.base);
      context.base.start = async (job, signal) => {
        const result = await start(job, signal);
        state.snapshot().baseSha = 'e'.repeat(40);

        return result;
      };

      state.coordinator.start();
      await state.coordinator.idle();
      await state.coordinator.stop();
      const view = saved(job.job.job.id, state.deps);

      assert.equal(context.launches.length, 1);
      assert.equal(context.prompts.length, 0);
      assert.equal(view.review.state, 'blocked');
      assert.equal(view.review.reason, 'review_target_changed');
      assert.notEqual(view.job.entry.claim, null);
    });
  },
);
