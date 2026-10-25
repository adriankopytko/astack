import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireCoordinatorOwnership } from '../src/adapters/state/coordinator-ownership.js';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  submitReview,
  createServiceCoordinator,
  acceptRunReport,
  nodeRunArtifactReader,
  inspectReviewResult,
  observeReviewResult,
  publishReviewResult,
  reconcileReviewPublication,
  submitImplementation,
  openSqliteState,
  type ReviewResultDependencies,
  type GithubPublicationReceipt,
  type RunDependencies,
} from '../src/index.js';
import { configurationDigest } from '../src/core/configuration.js';
import { renderImplementationPrompt } from '../src/core/implementation-prompt.js';
import { implementationTaskSchema } from '../src/contracts/implementation-task.js';
import { completed, rejected } from '../src/contracts/operation-result.js';
import { fixture as base, persisted, type CiReviewFixture } from './support/ci-review.js';
const options = { timeout: 180000 };
async function fixture(action: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await base(async (f) => action(await setup(f)));
}

async function setup(f: CiReviewFixture) {
  f.snapshot = { ...f.snapshot, checks: [{ name: 'ci', state: 'pass' }] };
  const checkout = await f.reviewer();
  const submitted = persisted(
    await submitReview(
      {
        schemaVersion: 1,
        projectId: f.f.job.job.projectId,
        checkoutId: checkout.checkoutId,
        key: 'findings-review',
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
  const coordinator = createServiceCoordinator({
    sessionId: 'review-results',
    dependencies: f.reviews,
    runtimes: [f.runtime],
    limits: { global: 2, defaultRole: 1, perRole: {} },
    onFailure: () => assert.fail('Coordinator failed'),
  });
  coordinator.start();

  try {
    await coordinator.idle();
  } finally {
    await coordinator.stop();
  }

  const artifactContent = 'Controlled review evidence\n';
  await writeFile(join(checkout.root, '.verification.json'), artifactContent);
  const artifacts = [
    {
      path: '.verification.json',
      digest: createHash('sha256').update(artifactContent).digest('hex'),
      size: Buffer.byteLength(artifactContent),
    },
  ];
  const job = submitted.job;
  const proposal = {
    schemaVersion: 1,
    jobId: job.job.id,
    attemptId: job.attempt.id,
    projectId: job.job.projectId,
    checkoutId: job.job.checkoutId,
    target: f.snapshot.target,
    outcome: 'reviewed' as const,
    summary: 'Static fixture review',
    findings: [
      {
        severity: 'high' as const,
        path: 'result.txt',
        line: 1,
        description: 'Handle the selected edge case.',
      },
    ],
    blockers: [],
    gate: submitted.assignment.submission.gate,
    acceptanceSnapshot: submitted.assignment.initialSnapshot,
    currentSnapshot: null,
  };
  const runDeps: RunDependencies = {
    ...f.reviews,
    runs: f.opened.runs,
    artifacts: nodeRunArtifactReader,
    workerInput: f.f.context.workerInput,
    workerControl: { interrupt: async () => assert.fail('No interrupt') },
  };
  let sequence = 0;
  let writes = 0;
  let finds = 0;
  let loseResponse = false;
  let receipt: GithubPublicationReceipt | null = null;
  let targetFailure = false;
  const deps: ReviewResultDependencies = {
    ...f.reviews,
    runs: f.opened.runs,
    results: f.opened.reviewResults,
    state: f.opened.store,
    now: () => f.now,
    nextId: () => `review-result-${++sequence}`,
    github: {
      ...f.f.deps.github,
      async inspectPullRequest() {
        if (targetFailure) {
          return rejected('github_timed_out', 'Synthetic timeout');
        }

        return completed({
          ...f.snapshot,
          target: f.snapshot.target,
          baseBranch: 'main',
          headBranch: 'task',
          title: 'Fixture',
          body: '',
          author: 'fixture',
        });
      },
      async findPublication() {
        finds++;

        return completed(receipt);
      },
      async publish(input) {
        writes++;

        assert.notEqual(input.publication.kind, 'pull-request');

        receipt = {
          schemaVersion: 1,
          kind: input.publication.kind,
          marker: input.marker,
          target: f.snapshot.target,
          id: 321,
          actor: input.publication.actor,
          observedAt: f.now,
        };

        return loseResponse
          ? {
              schemaVersion: 1,
              outcome: 'uncertain',
              error: { code: 'github_write_uncertain', message: 'Synthetic lost response' },
            }
          : completed(receipt);
      },
    },
  };
  const source = { schemaVersion: 1 as const, jobId: job.job.id, reportKey: 'review-report' };
  const acceptReport = (historical = false) =>
    acceptRunReport(
      {
        schemaVersion: 1,
        jobId: job.job.id,
        key: source.reportKey,
        proposal,
        artifacts,
        ...(historical ? { acceptHistoricalReview: true } : {}),
      },
      runDeps,
    );

  return {
    f,
    job,
    proposal,
    runDeps,
    deps,
    source,
    acceptReport,
    get writes() {
      return writes;
    },
    get finds() {
      return finds;
    },
    set loseResponse(value: boolean) {
      loseResponse = value;
    },
    set targetFailure(value: boolean) {
      targetFailure = value;
    },
    publishRequest(reportId: string) {
      return {
        schemaVersion: 1,
        request: {
          ...source,
          reportId,
          key: 'publish-review',
          actor: 'fixture',
          event: 'REQUEST_CHANGES',
        },
        writersStopped: true,
      };
    },
  };
}

await test(
  'accepted findings survive duplicate reports, reopen and publication retries without another write',
  options,
  async () => {
    await fixture(async (c) => {
      const accepted = persisted(await c.acceptReport());

      assert.ok(accepted.report);

      const duplicate = await c.acceptReport();

      assert.equal(duplicate.outcome, 'persisted');

      const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
      const command = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [cli, '--state-directory', c.f.f.context.context.state, ...args],
          { cwd: tmpdir(), encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' } },
        );
      const inspected = command(
        'review',
        'result',
        'inspect',
        c.job.job.id,
        '--report-key',
        c.source.reportKey,
        '--json',
      );

      assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
      assert.equal(JSON.parse(inspected.stdout).value.report.id, accepted.report.id);

      const ownership = await acquireCoordinatorOwnership(c.f.f.context.context.state);

      try {
        const excluded = command(
          'review',
          'result',
          'observe',
          '--job',
          c.job.job.id,
          '--report-key',
          c.source.reportKey,
          '--git-executable',
          '/nonexistent/astack-test-git',
          '--github-executable',
          '/nonexistent/astack-test-gh',
          '--json',
        );

        assert.equal(excluded.status, 1);
        assert.equal(JSON.parse(excluded.stdout).error.code, 'service_already_running');
      } finally {
        ownership.release();
      }

      const request = c.publishRequest(accepted.report.id);
      const published = persisted(await publishReviewResult(request, c.deps));

      assert.equal(published.effect.state, 'confirmed');
      assert.equal(c.writes, 1);
      assert.match(published.record.publication.body, /Finding 0: high/);

      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: c.f.f.context.context.state,
      });

      assert.ok(reopened.outcome === 'opened');

      try {
        const deps = {
          ...c.deps,
          runs: reopened.runs,
          results: reopened.reviewResults,
          state: reopened.store,
        };
        const saved = inspectReviewResult(c.source, deps);

        assert.ok(saved.outcome === 'completed');
        assert.deepEqual(saved.value.report.request.proposal, c.proposal);

        const retried = persisted(
          await publishReviewResult(request, {
            ...deps,
            github: {
              ...deps.github,
              inspectPullRequest: async () =>
                assert.fail('Historical retry must not inspect provider'),
            },
          }),
        );

        assert.equal(retried.effect.state, 'confirmed');
        assert.equal(c.writes, 1);
        assert.equal(
          (
            await publishReviewResult(
              { ...request, request: { ...request.request, actor: 'different' } },
              deps,
            )
          ).outcome,
          'rejected',
        );
      } finally {
        reopened.store.close();
      }
    });
  },
);

await test(
  'unknown publication survives restart and only read-only reconciliation can recover its exact receipt',
  options,
  async () => {
    await fixture(async (c) => {
      const report = persisted(await c.acceptReport()).report!;
      const request = c.publishRequest(report.id);
      c.loseResponse = true;
      const unknown = persisted(await publishReviewResult(request, c.deps));

      assert.equal(unknown.effect.state, 'unknown');
      assert.equal((await publishReviewResult(request, c.deps)).outcome, 'rejected');
      assert.equal(
        (
          await publishReviewResult(
            { ...request, request: { ...request.request, key: 'bypass' } },
            c.deps,
          )
        ).outcome,
        'rejected',
      );
      assert.equal(c.writes, 1);

      const source = { ...c.source, key: request.request.key, writersStopped: true };

      assert.equal(
        (await reconcileReviewPublication({ ...source, writersStopped: false }, c.deps)).outcome,
        'rejected',
      );

      c.f.snapshot = { ...c.f.snapshot, target: { ...c.f.snapshot.target, sha: 'f'.repeat(40) } };
      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: c.f.f.context.context.state,
      });

      assert.ok(reopened.outcome === 'opened');

      let recovered;

      try {
        recovered = persisted(
          await reconcileReviewPublication(source, {
            ...c.deps,
            results: reopened.reviewResults,
            runs: reopened.runs,
            state: reopened.store,
          }),
        );
      } finally {
        reopened.store.close();
      }

      assert.equal(recovered.effect.state, 'confirmed');
      assert.equal(c.writes, 1);
      assert.equal(c.finds, 1);
    });
  },
);

await test(
  'head changes retain explicit historical findings but cannot authorize new publication',
  options,
  async () => {
    await fixture(async (c) => {
      const originalTarget = c.f.snapshot.target;
      c.f.snapshot = {
        ...c.f.snapshot,
        target: { ...originalTarget, number: originalTarget.number + 1 },
      };

      assert.equal((await c.acceptReport(true)).outcome, 'rejected');

      c.f.snapshot = { ...c.f.snapshot, target: originalTarget };
      c.f.snapshot = { ...c.f.snapshot, target: { ...c.f.snapshot.target, sha: 'f'.repeat(40) } };

      assert.equal((await c.acceptReport()).outcome, 'rejected');

      const accepted = persisted(await c.acceptReport(true));

      assert.equal(accepted.report?.evidence.historicalReview, true);

      const observation = persisted(await observeReviewResult(c.source, c.deps));

      assert.equal(observation.state, 'stale');

      const inspected = inspectReviewResult(c.source, c.deps);

      assert.ok(inspected.outcome === 'completed');
      assert.deepEqual(inspected.value.report.request.proposal, c.proposal);
      assert.equal(inspected.value.observation?.state, 'stale');
      assert.equal(
        (await publishReviewResult(c.publishRequest(accepted.report!.id), c.deps)).outcome,
        'rejected',
      );
      assert.equal(c.writes, 0);

      c.targetFailure = true;
      const unavailable = persisted(await observeReviewResult(c.source, c.deps));

      assert.equal(unavailable.state, 'unavailable');
      assert.equal(unavailable.reason, 'github_timed_out');
    });
  },
);

await test(
  'result observations use CAS and publication validates identities and selected finding limits before effects',
  options,
  async () => {
    await fixture(async (c) => {
      c.proposal.findings = Array.from({ length: 32 }, () => ({
        ...c.proposal.findings[0]!,
        description: 'x'.repeat(1000),
      }));
      const wrong = await acceptRunReport(
        {
          schemaVersion: 1,
          jobId: c.job.job.id,
          key: 'wrong',
          proposal: { ...c.proposal, attemptId: 'wrong' },
        },
        c.runDeps,
      );

      assert.equal(wrong.outcome, 'rejected');

      const accepted = persisted(await c.acceptReport());
      const report = accepted.report!;
      const original = c.deps.results;
      const first = persisted(await observeReviewResult(c.source, c.deps));
      const late = original.observe({
        source: c.source,
        reportId: report.id,
        expectedRevision: null,
        observation: { reportId: report.id, state: 'current', reason: null, observedAt: c.f.now },
      });

      assert.equal(late.outcome, 'rejected');
      assert.equal(first.revision, 0);

      const oversized = c.publishRequest(report.id);

      assert.equal((await publishReviewResult(oversized, c.deps)).outcome, 'rejected');

      const request = { ...oversized, request: { ...oversized.request, findingIndexes: [0] } };

      for (const bad of [
        { ...request, request: { ...request.request, reportId: 'wrong' } },
        { ...request, request: { ...request.request, findingIndexes: [32] } },
        { ...request, writersStopped: false },
      ]) {
        assert.equal((await publishReviewResult(bad, c.deps)).outcome, 'rejected');
      }

      assert.equal(c.writes, 0);

      const race = await Promise.all([
        publishReviewResult(request, c.deps),
        publishReviewResult(request, c.deps),
      ]);

      assert.ok(race.some((r) => r.outcome === 'persisted'));
      assert.equal(c.writes, 1);
    });
  },
);

await test(
  'explicit fixes link an immutable accepted review and require a fresh owned implementation checkout',
  options,
  async () => {
    await fixture(async (c) => {
      const report = persisted(await c.acceptReport()).report!;
      const checkout = await c.f.reviewer('fix-checkout');
      const fixOf = {
        jobId: c.job.job.id,
        attemptId: c.job.attempt.id,
        reportId: report.id,
        reportKey: c.source.reportKey,
        reportDigest: configurationDigest(report),
        commit: c.proposal.target.sha,
        findingIndexes: [0],
      };
      const request = {
        schemaVersion: 1,
        projectId: c.job.job.projectId,
        checkoutId: checkout.checkoutId,
        key: 'fix-result',
        branch: checkout.branch,
        commit: checkout.commit,
        description: 'Fix finding 0: handle the selected edge case in result.txt.',
        acceptanceCriteria: ['Cover the selected edge case.'],
        instructionPaths: ['AGENTS.md'],
        request: {},
        fixOf,
      };
      const deps = { ...c.f.reviews, runs: c.f.opened.runs };
      const rejectedRequest = { ...request, fixOf: { ...fixOf, reportDigest: '0'.repeat(64) } };

      assert.equal((await submitImplementation(rejectedRequest, deps)).outcome, 'rejected');
      assert.equal(
        (
          await submitImplementation(
            { ...request, checkoutId: c.job.job.checkoutId, branch: c.job.entry.branch },
            deps,
          )
        ).outcome,
        'rejected',
      );

      const submitted = persisted(await submitImplementation(request, deps));
      const task = implementationTaskSchema.parse(submitted.job.job.intent.task);

      assert.deepEqual(task.submission.fixOf, fixOf);
      assert.match(
        renderImplementationPrompt(submitted.job, task),
        /Explicit review fix reference/,
      );
      assert.equal((await submitImplementation(request, deps)).outcome, 'persisted');
      assert.equal(
        (await submitImplementation({ ...request, key: 'reuse' }, deps)).outcome,
        'rejected',
      );

      const events = c.f.opened.runs.events({
        schemaVersion: 1,
        jobId: c.job.job.id,
        after: 0,
        limit: 100,
        waitMs: 0,
      });

      assert.ok(events.outcome === 'completed');
      assert.ok(
        events.value.events.some(
          (e) =>
            e.kind === 'review_fix_accepted' &&
            e.detail.implementationJobId === submitted.job.job.id,
        ),
      );
      assert.equal(c.writes, 0);
    });
  },
);

await test(
  'publication intent and its host job roll back together when the source event fails',
  options,
  async () => {
    await fixture(async (c) => {
      const report = persisted(await c.acceptReport()).report!;
      const request = c.publishRequest(report.id);
      const raw = new DatabaseSync(join(c.f.f.context.context.state, 'state.sqlite'));

      try {
        raw.exec(
          "CREATE TRIGGER reject_review_publication BEFORE INSERT ON run_events WHEN json_extract(NEW.data,'$.kind')='review_publication_prepared' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;",
        );

        assert.equal((await publishReviewResult(request, c.deps)).outcome, 'rejected');
        assert.equal(c.writes, 0);
        assert.equal(
          raw
            .prepare(
              "SELECT COUNT(*) AS count FROM jobs WHERE operation='review-result-publication'",
            )
            .get()?.count,
          0,
        );
        assert.equal(
          raw.prepare('SELECT COUNT(*) AS count FROM review_result_publications').get()?.count,
          0,
        );

        raw.exec('DROP TRIGGER reject_review_publication');
        const retried = persisted(await publishReviewResult(request, c.deps));

        assert.equal(retried.effect.state, 'confirmed');
        assert.equal(c.writes, 1);
      } finally {
        raw.close();
      }
    });
  },
);
