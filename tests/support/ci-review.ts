import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  finishImplementation,
  prepareWorktree,
  createWorktreeGit,
  nodeProcessRunner,
  createReviewRuntime,
  ciPolicySchema,
  observeCi,
  watchCi,
  enqueueFollowUpReview,
  configureReviewAutomation,
  dispatchFollowUpReviews,
  type CiDependencies,
  type AutomaticReviewDependencies,
  type ReviewDependencies,
  type ReviewSnapshot,
  type GithubResult,
  type StateWriteResult,
  type CiView,
  type FollowUpPlan,
} from '../../src/index.js';
import { completed } from '../../src/contracts/operation-result.js';
import { fixture as handoffFixture, type HandoffFixture } from './handoff.js';
import { gitPath } from './service.js';
export function persisted<T>(result: StateWriteResult<T>): T {
  assert.ok(result.outcome === 'persisted', JSON.stringify(result));

  return result.value;
}

async function setup(f: HandoffFixture) {
  const accepted = persisted(await finishImplementation(f.input, f.deps));
  const opened = f.context.context.opened;
  let now = 1000;
  let sequence = 0;
  let snapshot: ReviewSnapshot = {
    target: { ...f.request.publication.target, number: 12, sha: f.head },
    baseSha: f.request.publication.baseSha,
    state: 'OPEN',
    draft: false,
    sourceRepository: 'example/project',
    checks: [{ name: 'ci', state: 'pending' }],
    observedAt: now,
  };
  const reader = {
    calls: 0,
    targetCalls: 0,
    maxRequests: [] as number[],
    response: null as GithubResult<ReviewSnapshot> | null,
    duringRead: null as (() => Promise<void>) | null,
    duringTarget: null as (() => Promise<void>) | null,
  };
  const reviews: ReviewDependencies = {
    ...f.context.deps,
    automaticReviews: opened.automaticReviews,
    now: () => now,
    targets: {
      async read() {
        reader.targetCalls++;
        await reader.duringTarget?.();

        return completed({ ...snapshot, observedAt: now });
      },
    },
  };
  const ci: CiDependencies = {
    ...f.deps,
    ci: opened.ci,
    automaticCi: opened.automaticReviews,
    configuration: reviews.configuration,
    now: () => now,
    nextId: () => `ci-test-${++sequence}`,
    random: () => 0.5,
    reader: {
      async read(input) {
        reader.calls++;
        reader.maxRequests.push(input.maxRequests);

        assert.deepEqual(
          input.target,
          snapshot.target.sha === f.head ? snapshot.target : { ...snapshot.target, sha: f.head },
        );

        await reader.duringRead?.();

        return reader.response ?? completed({ ...snapshot, observedAt: now });
      },
    },
  };
  let wakes = 0;
  let ciWakes = 0;
  const automatic: AutomaticReviewDependencies = {
    executorEnabled: true,
    store: opened.automaticReviews,
    reviews,
    ci,
    now: () => now,
    wake: () => {
      wakes++;
    },
    wakeCi: () => {
      ciWakes++;
    },
  };
  const policy = ciPolicySchema.parse({
    intervalMs: 1000,
    maxIntervalMs: 8000,
    maxRequestsPerObservation: 4,
    requestsPerWindow: 40,
    windowMs: 10000,
  });
  const ciRequest = (key: string, timeoutMs = 60000) => ({
    schemaVersion: 1,
    source: { kind: 'handoff', jobId: f.job.job.id, key: f.request.key },
    key,
    timeoutMs,
  });
  const savedCi = (id: string): CiView => {
    const value = opened.ci.find(id);

    assert.ok(value.outcome === 'completed' && value.value, JSON.stringify(value));

    return value.value;
  };

  const savedPlan = (id: string): FollowUpPlan => {
    const value = opened.automaticReviews.find(id);

    assert.ok(value.outcome === 'completed' && value.value, JSON.stringify(value));

    return value.value;
  };

  async function reviewer(key = `review-${++sequence}`) {
    const result = await prepareWorktree(
      {
        schemaVersion: 1,
        projectId: f.job.job.projectId,
        key,
        branch: `refs/heads/${key}`,
        baseCommit: f.head,
      },
      {
        ...f.context.deps,
        store: opened.worktrees,
        files: f.deps.files,
        managedRoot: join(f.context.context.state, 'worktrees'),
        effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
        nextId: (kind) => `${kind}-ci-review-${++sequence}`,
      },
    );

    assert.ok('record' in result && result.record?.phase === 'ready', JSON.stringify(result));

    return {
      checkoutId: result.record.intent.checkoutId,
      branch: result.record.intent.branch,
      commit: f.head,
      root: result.record.intent.checkoutPath,
    };
  }

  async function enable(enabled = true) {
    const settings = opened.automaticReviews.settings(f.job.job.projectId);

    assert.ok(settings.outcome === 'completed');

    return persisted(
      await configureReviewAutomation(
        {
          schemaVersion: 1,
          projectId: f.job.job.projectId,
          expectedRevision: settings.value.revision,
          enabled,
        },
        automatic,
      ),
    );
  }

  const runtime = createReviewRuntime({
    runtime: f.context.base,
    dependencies: reviews,
    workerInput: f.context.workerInput,
  });

  return {
    f,
    accepted,
    opened,
    reviews,
    ci,
    automatic,
    policy,
    reader,
    runtime,
    reviewer,
    enable,
    savedCi,
    savedPlan,
    ciRequest,
    get now() {
      return now;
    },
    advance(ms = 100000) {
      now += ms;
    },
    at(time: number) {
      assert.ok(time >= now);

      now = time;
    },
    get snapshot() {
      return snapshot;
    },
    set snapshot(value: ReviewSnapshot) {
      snapshot = value;
    },
    get wakes() {
      return wakes;
    },
    get ciWakes() {
      return ciWakes;
    },
    watch: async (key: string, timeoutMs?: number) =>
      persisted(await watchCi(ciRequest(key, timeoutMs), ci)),
    tick: () => observeCi({ schemaVersion: 1 }, ci, policy),
    dispatch: () => dispatchFollowUpReviews(automatic),
    enqueue: async (checkout: Awaited<ReturnType<typeof reviewer>>) =>
      persisted(
        await enqueueFollowUpReview(
          {
            schemaVersion: 1,
            jobId: f.job.job.id,
            handoffKey: f.request.key,
            checkoutId: checkout.checkoutId,
            branch: checkout.branch,
            commit: checkout.commit,
            timeoutMs: 60000,
          },
          automatic,
        ),
      ),
  };
}

export type CiReviewFixture = Awaited<ReturnType<typeof setup>>;
export async function fixture(action: (context: CiReviewFixture) => Promise<void>) {
  await handoffFixture(async (f) => action(await setup(f)));
}
