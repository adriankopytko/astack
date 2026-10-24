import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFile, readFile, mkdtemp, realpath, rm, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectRunReport,
  submitReview,
  createReviewRuntime,
  submitImplementation,
  inspectImplementation,
  createServiceCoordinator,
  acceptRunReport,
  inspectRun,
  respondToRun,
  resumeRun,
  cancelRun,
  readRunEvents,
  readRunCursor,
  checkpointRunEvents,
  nodeRunArtifactReader,
  openSqliteState,
  startLocalService,
  requestLocalService,
  runWriteResultSchema,
  runReadResultSchema,
  runEventsResultSchema,
  type RunDependencies,
  type RunView,
  type StateWriteResult,
} from '../src/index.js';
import { completed } from '../src/contracts/operation-result.js';
import { fixture } from './support/implementation.js';
import { git, gitPath } from './support/service.js';
const options = { timeout: 90000 };
type Context = Parameters<Parameters<typeof fixture>[0]>[0];
function accepted(result: StateWriteResult<RunView>): RunView {
  runWriteResultSchema.parse(result);

  if (result.outcome !== 'persisted') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

function saved(id: string, deps: Pick<RunDependencies, 'runs'>): RunView {
  const result = inspectRun({ schemaVersion: 1, jobId: id }, deps);
  runReadResultSchema.parse(result);

  assert.ok(result.outcome === 'completed' && result.value, JSON.stringify(result));

  return result.value;
}

function dependencies(context: Context) {
  const interrupts: { attemptId: string; key: string }[] = [];
  const deps: RunDependencies = {
    ...context.deps,
    runs: context.context.opened.runs,
    artifacts: nodeRunArtifactReader,
    workerInput: context.workerInput,
    targets: { read: async () => assert.fail('Implementation lifecycle must not query GitHub') },
    workerControl: {
      async interrupt(input) {
        interrupts.push(input);

        return completed({ state: 'acknowledged' as const });
      },
    },
  };
  const coordinator = createServiceCoordinator({
    sessionId: 'runs-fixture',
    dependencies: deps,
    runtimes: [context.runtime],
    limits: { global: 1, defaultRole: 1, perRole: {} },
    onFailure: () => assert.fail('Fixture coordinator failed'),
  });

  return { deps, coordinator, interrupts };
}

async function prepare(context: Context) {
  const request = await context.prepare();
  const setup = dependencies(context);
  const submission = await submitImplementation(request, setup.deps);

  assert.ok(submission.outcome === 'persisted', JSON.stringify(submission));

  const job = submission.value.job;
  const proposal = {
    schemaVersion: 1,
    jobId: job.job.id,
    attemptId: job.attempt.id,
    projectId: job.job.projectId,
    checkoutId: job.job.checkoutId,
    branch: job.entry.branch,
    baseCommit: job.entry.commit,
    headCommit: job.entry.commit,
    outcome: 'completed' as 'completed' | 'needs_decision' | 'failed',
    summary: 'Fixture report',
    blockers: [] as string[],
  };

  return { ...setup, request, job, proposal };
}

await test(
  'validated terminal reports are durable and idempotent while worker capacity and work remain retained',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, proposal } = await prepare(context);
      coordinator.start();
      await coordinator.idle();

      try {
        const report = {
          schemaVersion: 1,
          jobId: job.job.id,
          key: 'report-1',
          proposal,
          artifacts: [],
        };
        const result = accepted(await acceptRunReport(report, deps));

        assert.equal(result.status, 'completed');
        assert.equal(result.control.phase, 'completed');
        assert.equal(result.job.entry.state, 'started');
        assert.equal(result.cleanup.state, 'retained');
        assert.ok(result.cleanup.resourceCount > 0);
        assert.equal(
          result.cleanup.resources.some((resource) => resource.releasedAt === null),
          true,
        );

        const task = inspectImplementation({ schemaVersion: 1, jobId: job.job.id }, deps);

        assert.ok(task.outcome === 'completed' && task.value);
        assert.equal(task.value.implementation.acceptedOutcome, 'completed');

        const duplicate = await acceptRunReport(report, {
          ...deps,
          artifacts: { inspect: async () => assert.fail('Duplicate acceptance must be offline') },
        });

        assert.equal(duplicate.outcome === 'persisted' && duplicate.disposition, 'existing');
        assert.equal(
          (
            await acceptRunReport(
              { ...report, proposal: { ...proposal, summary: 'Changed' } },
              deps,
            )
          ).outcome,
          'rejected',
        );

        const reopened = await openSqliteState({
          schemaVersion: 1,
          stateDirectory: context.context.state,
          mode: 'read-only',
        });

        assert.equal(reopened.outcome, 'opened');

        if (reopened.outcome === 'opened') {
          assert.equal(
            saved(job.job.id, { runs: reopened.runs }).report?.request.proposal.summary,
            'Fixture report',
          );

          reopened.store.close();
        }

        assert.equal(context.prompts.length, 1);
      } finally {
        await coordinator.stop();
      }
    });
  },
);
await test(
  'report validation rejects undelivered tasks, wrong identities, stale local SHA and dirty completion',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, proposal } = await prepare(context);
      const report = { schemaVersion: 1, jobId: job.job.id, key: 'bad-report', proposal };

      assert.equal((await acceptRunReport(report, deps)).outcome, 'rejected');

      coordinator.start();
      await coordinator.idle();

      try {
        assert.equal(
          (
            await acceptRunReport(
              { ...report, proposal: { ...proposal, attemptId: 'wrong-attempt' } },
              deps,
            )
          ).outcome,
          'rejected',
        );
        assert.equal(
          (
            await acceptRunReport(
              { ...report, proposal: { ...proposal, headCommit: 'f'.repeat(40) } },
              deps,
            )
          ).outcome,
          'rejected',
        );

        const task = job.job.intent.task;

        assert.ok(
          task && typeof task === 'object' && !Array.isArray(task) && typeof task.root === 'string',
        );

        await writeFile(join(task.root, 'pending.txt'), 'Uncommitted work');

        assert.equal((await acceptRunReport(report, deps)).outcome, 'rejected');

        const decision = accepted(
          await acceptRunReport(
            {
              ...report,
              proposal: { ...proposal, outcome: 'needs_decision', blockers: ['Choose behavior'] },
            },
            deps,
          ),
        );

        assert.equal(decision.status, 'needs_decision');
        assert.equal(decision.report?.request.proposal.outcome, 'needs_decision');
      } finally {
        await coordinator.stop();
      }
    });
  },
);
await test(
  'accepted artifact references match committed bytes and remain references rather than copied content',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, proposal } = await prepare(context);
      coordinator.start();
      await coordinator.idle();

      try {
        const task = job.job.intent.task;

        assert.ok(
          task && typeof task === 'object' && !Array.isArray(task) && typeof task.root === 'string',
        );

        const bytes = 'Fixture verification evidence\n';
        await writeFile(join(task.root, 'evidence.txt'), bytes);
        git(task.root, 'add', 'evidence.txt');
        git(task.root, 'commit', '-m', 'test: add fixture evidence');
        const head = git(task.root, 'rev-parse', 'HEAD');
        const reference = {
          path: 'evidence.txt',
          size: Buffer.byteLength(bytes),
          digest: createHash('sha256').update(bytes).digest('hex'),
        };
        const report = {
          schemaVersion: 1,
          jobId: job.job.id,
          key: 'artifact-report',
          proposal: { ...proposal, headCommit: head },
          artifacts: [reference],
        };

        assert.equal(
          (
            await acceptRunReport(
              { ...report, artifacts: [{ ...reference, digest: 'f'.repeat(64) }] },
              deps,
            )
          ).outcome,
          'rejected',
        );

        const result = accepted(await acceptRunReport(report, deps));

        assert.deepEqual(result.report?.request.artifacts, [reference]);
        assert.equal(JSON.stringify(result).includes(bytes), false);
        assert.equal(await readFile(join(task.root, 'evidence.txt'), 'utf8'), bytes);
      } finally {
        await coordinator.stop();
      }
    });
  },
);
await test(
  'decision responses persist without input and explicit resume is keyed and never relaunches the worker',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, proposal } = await prepare(context);
      coordinator.start();
      await coordinator.idle();

      try {
        const decision = accepted(
          await acceptRunReport(
            {
              schemaVersion: 1,
              jobId: job.job.id,
              key: 'decision',
              proposal: {
                ...proposal,
                outcome: 'needs_decision',
                blockers: ['Choose implementation'],
              },
            },
            deps,
          ),
        );

        assert.ok(decision.control.reportId);

        const response = {
          schemaVersion: 1,
          jobId: job.job.id,
          key: 'answer',
          decisionId: decision.control.reportId,
          text: 'Use the existing public interface.',
        };
        const answered = accepted(respondToRun(response, deps));

        assert.equal(context.prompts.length, 1);
        assert.equal(
          accepted(respondToRun(response, deps)).responses[0]?.id,
          answered.responses[0]?.id,
        );
        assert.equal(
          respondToRun({ ...response, text: 'Changed answer' }, deps).outcome,
          'rejected',
        );

        const responseId = answered.responses[0]?.id;

        assert.ok(responseId);

        const request = { schemaVersion: 1, jobId: job.job.id, key: 'resume-1', responseId };
        const submit = deps.workerInput.submit.bind(deps.workerInput);
        let sends = 0;
        deps.workerInput.submit = async (input, signal) => {
          sends++;
          const result = await submit(input, signal);

          return result.outcome === 'completed'
            ? completed({ ...result.value, blocker: 'identity_changed' as const })
            : result;
        };

        const submissions = await Promise.all([resumeRun(request, deps), resumeRun(request, deps)]);

        assert.ok(submissions.some((result) => result.outcome === 'persisted'));

        const uncertain = saved(job.job.id, deps);

        assert.equal(sends, 1);
        assert.equal(uncertain.status, 'unknown');

        deps.workerInput.submit = submit;
        const resumed = accepted(await resumeRun(request, deps));

        assert.equal(resumed.resumes[0]?.state, 'acknowledged');
        assert.equal(resumed.control.phase, 'active');
        assert.match(context.prompts[1]?.text ?? '', /Explicit decision response/);
        assert.equal(context.launches.length, 1);

        accepted(await resumeRun(request, deps));

        assert.equal(context.prompts.length, 2);

        const finished = accepted(
          await acceptRunReport(
            { schemaVersion: 1, jobId: job.job.id, key: 'finished', proposal },
            deps,
          ),
        );

        assert.equal(finished.status, 'completed');
      } finally {
        await coordinator.stop();
      }
    });
  },
);
await test(
  'lost continuation acknowledgement remains unknown on retry and cannot accept a later report',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, proposal } = await prepare(context);
      coordinator.start();
      await coordinator.idle();

      try {
        const decision = accepted(
          await acceptRunReport(
            {
              schemaVersion: 1,
              jobId: job.job.id,
              key: 'decision',
              proposal: { ...proposal, outcome: 'needs_decision' },
            },
            deps,
          ),
        );
        const answer = accepted(
          respondToRun(
            {
              schemaVersion: 1,
              jobId: job.job.id,
              key: 'answer',
              decisionId: decision.control.reportId,
              text: 'Continue safely.',
            },
            deps,
          ),
        );
        context.modes.input = 'lost';
        const request = {
          schemaVersion: 1,
          jobId: job.job.id,
          key: 'resume',
          responseId: answer.responses[0]?.id,
        };

        assert.equal(accepted(await resumeRun(request, deps)).status, 'unknown');

        accepted(await resumeRun(request, deps));

        assert.equal(context.prompts.length, 2);
        assert.equal(context.launches.length, 1);
        assert.equal(
          (
            await acceptRunReport(
              { schemaVersion: 1, jobId: job.job.id, key: 'finished', proposal },
              deps,
            )
          ).outcome,
          'rejected',
        );
      } finally {
        await coordinator.stop();
      }
    });
  },
);
await test(
  'cancelling a queued job prevents dispatch and claims atomically while preserving its checkout',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, interrupts } = await prepare(context);
      const request = { schemaVersion: 1, jobId: job.job.id, key: 'cancel', interrupt: true };
      const cancelled = accepted(await cancelRun(request, deps));

      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancellation?.interruptState, 'not_needed');

      coordinator.start();
      await coordinator.idle();
      await coordinator.stop();

      assert.equal(context.launches.length, 0);
      assert.equal(interrupts.length, 0);

      const claim = deps.queue.claim({
        jobId: job.job.id,
        owner: 'late-service',
        token: 'late-claim',
        now: 2000,
        limits: { global: 1, defaultRole: 1, perRole: {} },
      });

      assert.ok(claim.outcome === 'persisted' && claim.value === null);

      accepted(await cancelRun(request, deps));
      const task = job.job.intent.task;

      assert.ok(
        task && typeof task === 'object' && !Array.isArray(task) && typeof task.root === 'string',
      );
      assert.equal((await stat(task.root)).isDirectory(), true);
    });
  },
);
await test(
  'cancellation winning during preflight prevents a later capacity claim or native start',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await context.prepare();
      const { deps } = dependencies(context);
      const submitted = await submitImplementation(request, deps);

      assert.ok(submitted.outcome === 'persisted');

      const runtime = {
        ...context.runtime,
        async preflight(
          job: Parameters<NonNullable<typeof context.runtime.preflight>>[0],
          signal: AbortSignal,
        ) {
          accepted(
            await cancelRun({ schemaVersion: 1, jobId: job.job.id, key: 'race-cancel' }, deps),
          );

          return context.runtime.preflight
            ? context.runtime.preflight(job, signal)
            : completed({ ready: true as const });
        },
      };
      const coordinator = createServiceCoordinator({
        sessionId: 'race-service',
        dependencies: deps,
        runtimes: [runtime],
        limits: { global: 1, defaultRole: 1, perRole: {} },
        onFailure: () => assert.fail('Race fixture failed'),
      });
      coordinator.start();
      await coordinator.idle();
      await coordinator.stop();

      assert.equal(context.launches.length, 0);
      assert.equal(saved(submitted.value.job.job.id, deps).control.phase, 'cancelled');
    });
  },
);
await test(
  'running cancellation is a durable request, interrupts once, and requires quiescence before becoming cancelled',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, interrupts, proposal } = await prepare(context);
      coordinator.start();
      await coordinator.idle();

      try {
        const request = {
          schemaVersion: 1,
          jobId: job.job.id,
          key: 'cancel-running',
          interrupt: true,
        };
        const raced = await acceptRunReport(
          { schemaVersion: 1, jobId: job.job.id, key: 'cancel-raced-report', proposal },
          {
            ...deps,
            artifacts: {
              async inspect(input) {
                accepted(await cancelRun(request, deps));

                return completed(input.artifacts);
              },
            },
          },
        );

        assert.equal(raced.outcome, 'rejected');

        const pending = saved(job.job.id, deps);

        assert.equal(pending.report, null);

        assert.equal(pending.status, 'cancel_requested');
        assert.equal(pending.cancellation?.interruptState, 'acknowledged');

        accepted(await cancelRun(request, deps));

        assert.equal(interrupts.length, 1);

        context.modes.runtime = 'unknown';
        coordinator.wake();
        await coordinator.idle();
        const uncertain = saved(job.job.id, deps);

        assert.equal(uncertain.control.phase, 'cancel_requested');
        assert.equal(uncertain.job.entry.state, 'unknown');

        context.base.inspect = async (selected) => ({
          state: 'quiescent',
          handle: { attemptId: selected.attempt.id },
          evidence: { proof: 'fixture-owned-worker-stopped' },
        });
        coordinator.wake();
        await coordinator.idle();
        const stopped = saved(job.job.id, deps);

        assert.equal(stopped.status, 'cancelled');
        assert.equal(stopped.cleanup.state, 'retained');
        assert.equal(context.launches.length, 1);
        assert.equal(context.prompts.length, 1);
      } finally {
        await coordinator.stop();
      }
    });
  },
);
await test(
  'events and scope-specific CAS cursors survive reconnect without acknowledging unseen work automatically',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, job } = await prepare(context);
      const page = await readRunEvents(
        { schemaVersion: 1, jobId: job.job.id, limit: 1 },
        {
          runs: deps.runs,
          now: Date.now,
          waiter: { pause: async () => assert.fail('Unexpected wait') },
        },
      );
      runEventsResultSchema.parse(page);

      assert.ok(page.outcome === 'completed' && page.value.events.length === 1);

      const cursorRequest = { schemaVersion: 1, consumer: 'orchestrator', jobId: job.job.id };
      const initial = readRunCursor(cursorRequest, deps);

      assert.ok(initial.outcome === 'completed');
      assert.equal(initial.value.after, 0);

      const checkpoint = checkpointRunEvents(
        { ...cursorRequest, expected: 0, after: page.value.nextCursor },
        deps,
      );

      assert.ok(checkpoint.outcome === 'persisted');

      const otherScope = readRunCursor(
        { schemaVersion: 1, consumer: 'orchestrator', projectId: job.job.projectId },
        deps,
      );

      assert.ok(otherScope.outcome === 'completed');
      assert.equal(otherScope.value.after, 0);

      const otherJob = await context.context.submit(1, 'other-project-event');
      const filtered = await readRunEvents(
        { schemaVersion: 1, jobId: job.job.id, after: page.value.nextCursor },
        { runs: deps.runs, now: Date.now, waiter: { pause: async () => {} } },
      );

      assert.ok(filtered.outcome === 'completed' && filtered.value.events.length === 0);
      assert.ok(filtered.value.nextCursor > page.value.nextCursor);
      assert.notEqual(otherJob.job.projectId, job.job.projectId);

      accepted(await cancelRun({ schemaVersion: 1, jobId: job.job.id, key: 'cancel' }, deps));
      const stale = checkpointRunEvents(
        { ...cursorRequest, expected: 0, after: page.value.nextCursor + 1 },
        deps,
      );

      assert.equal(stale.outcome, 'rejected');

      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: context.context.state,
        mode: 'read-only',
      });

      assert.ok(reopened.outcome === 'opened');

      try {
        const cursor = readRunCursor(cursorRequest, { runs: reopened.runs });

        assert.ok(cursor.outcome === 'completed');
        assert.equal(cursor.value.after, page.value.nextCursor);

        const rest = await readRunEvents(
          { schemaVersion: 1, jobId: job.job.id, after: cursor.value.after },
          { runs: reopened.runs, now: Date.now, waiter: { pause: async () => {} } },
        );

        assert.ok(
          rest.outcome === 'completed' &&
            rest.value.events.some((event) => event.kind === 'cancelled'),
        );
        assert.equal(
          rest.value.events.every((event) => event.id > cursor.value.after),
          true,
        );
      } finally {
        reopened.store.close();
      }
    });
  },
);
await test(
  'event waiting reads only local durable state and cancellation does not advance any consumer cursor',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, job } = await prepare(context);
      const page = deps.runs.events({ schemaVersion: 1, after: 0, limit: 100, waitMs: 0 });

      assert.ok(page.outcome === 'completed');

      let pauses = 0;
      const result = await readRunEvents(
        { schemaVersion: 1, after: page.value.nextCursor, waitMs: 1000 },
        {
          runs: deps.runs,
          now: () => 0,
          waiter: {
            async pause() {
              pauses++;
              accepted(
                await cancelRun({ schemaVersion: 1, jobId: job.job.id, key: 'during-wait' }, deps),
              );
            },
          },
        },
      );

      assert.ok(
        result.outcome === 'completed' &&
          result.value.events.some((event) => event.kind === 'cancelled'),
      );
      assert.equal(pauses, 1);

      const controller = new AbortController();
      const aborted = await readRunEvents(
        { schemaVersion: 1, after: result.value.nextCursor, waitMs: 1000 },
        {
          runs: deps.runs,
          now: () => 0,
          waiter: {
            async pause() {
              controller.abort();
            },
          },
        },
        controller.signal,
      );

      assert.equal(aborted.outcome === 'rejected' && aborted.error.code, 'cancelled');
      assert.equal(context.launches.length, 0);
    });
  },
);
await test(
  'artifact inspection rejects traversal, symlinks, hard links, wrong digests and oversized references',
  options,
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astack-artifacts-')));

    try {
      await writeFile(join(root, 'evidence.txt'), 'Evidence');
      const reference = {
        path: 'evidence.txt',
        size: 8,
        digest: createHash('sha256').update('Evidence').digest('hex'),
      };

      assert.equal(
        (await nodeRunArtifactReader.inspect({ root, artifacts: [reference] })).outcome,
        'completed',
      );

      await symlink(join(root, 'evidence.txt'), join(root, 'linked.txt'));

      assert.equal(
        (
          await nodeRunArtifactReader.inspect({
            root,
            artifacts: [{ ...reference, path: 'linked.txt' }],
          })
        ).outcome,
        'rejected',
      );
      assert.equal(
        (
          await nodeRunArtifactReader.inspect({
            root,
            artifacts: [{ ...reference, path: '../evidence.txt' }],
          })
        ).outcome,
        'rejected',
      );

      await link(join(root, 'evidence.txt'), join(root, 'hard.txt'));

      assert.equal(
        (await nodeRunArtifactReader.inspect({ root, artifacts: [reference] })).outcome,
        'rejected',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
await test(
  'live RPC and compiled CLI expose offline run inspection and bounded events from a neutral cwd',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, job } = await prepare(context);
      const service = await startLocalService({
        schemaVersion: 1,
        stateDirectory: context.context.state,
        gitExecutable: gitPath,
      });

      assert.equal(service.outcome, 'listening', JSON.stringify(service));

      if (service.outcome !== 'listening') {
        return;
      }

      try {
        const cancelled = await requestLocalService(context.context.state, {
          schemaVersion: 1,
          operation: 'run_cancel',
          jobId: job.job.id,
          key: 'rpc-cancel',
          interrupt: false,
        });

        assert.ok(
          cancelled.outcome === 'persisted' && 'cleanup' in cancelled.value,
          JSON.stringify(cancelled),
        );

        const events = await requestLocalService(context.context.state, {
          schemaVersion: 1,
          operation: 'run_events',
          after: 0,
          limit: 100,
          waitMs: 0,
        });

        assert.ok(events.outcome === 'completed' && events.value && 'events' in events.value);

        const waiting = requestLocalService(context.context.state, {
          schemaVersion: 1,
          operation: 'run_events',
          after: events.value.highWatermark,
          jobId: job.job.id,
          limit: 100,
          waitMs: 20000,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const shutdownAt = Date.now();
        await service.close();
        await waiting;

        assert.ok(
          Date.now() - shutdownAt < 2000,
          'Shutdown should abort a bounded local event wait.',
        );

        const entry = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
        const result = await new Promise<{ code: number | null; stdout: string }>(
          (resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                entry,
                '--state-directory',
                context.context.state,
                'run',
                'inspect',
                job.job.id,
                '--json',
              ],
              { cwd: context.context.root, stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let stdout = '';
            child.stdout.on('data', (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout }));
          },
        );

        assert.equal(result.code, 0, result.stdout);

        const parsed = runReadResultSchema.parse(JSON.parse(result.stdout));

        assert.ok(parsed.outcome === 'completed' && parsed.value?.control.phase === 'cancelled');
        assert.equal(saved(job.job.id, deps).cleanup.state, 'retained');
      } finally {
        await service.close();
      }
    });
  },
);

await test(
  'review report acceptance rechecks pinned head and base and records fresh CI evidence',
  options,
  async () => {
    await fixture(async (context) => {
      const {
        description: _description,
        acceptanceCriteria: _criteria,
        ...base
      } = await context.prepare();
      const { deps } = dependencies(context);
      const target = {
        host: 'github.com',
        repository: 'example/project',
        number: 42,
        sha: base.commit,
      };
      let snapshot = {
        target,
        baseSha: base.commit,
        state: 'OPEN' as const,
        draft: false,
        sourceRepository: 'contributor/fork',
        checks: [{ name: 'test', state: 'pass' as const }],
        observedAt: 100,
      };
      deps.targets = { read: async () => completed(structuredClone(snapshot)) };
      const submitted = await submitReview({ ...base, target }, deps);

      assert.ok(submitted.outcome === 'persisted', JSON.stringify(submitted));

      const job = submitted.value.job;
      const assignment = submitted.value.assignment;
      const runtime = createReviewRuntime({
        runtime: context.runtime,
        dependencies: deps,
        workerInput: context.workerInput,
      });
      const coordinator = createServiceCoordinator({
        sessionId: 'review-results',
        dependencies: deps,
        runtimes: [runtime],
        limits: { global: 1, defaultRole: 1, perRole: {} },
        onFailure: () => assert.fail('Review result fixture failed'),
      });
      coordinator.start();
      await coordinator.idle();

      try {
        const proposal = {
          schemaVersion: 1,
          jobId: job.job.id,
          attemptId: job.attempt.id,
          projectId: job.job.projectId,
          checkoutId: job.job.checkoutId,
          target,
          outcome: 'reviewed',
          summary: 'Fixture static review',
          findings: [],
          blockers: [],
          gate: assignment.submission.gate,
          acceptanceSnapshot: assignment.initialSnapshot,
          currentSnapshot: null,
        };
        const report = { schemaVersion: 1, jobId: job.job.id, key: 'review-result', proposal };
        snapshot = { ...snapshot, baseSha: 'f'.repeat(40) };

        assert.equal((await acceptRunReport(report, deps)).outcome, 'rejected');

        snapshot = { ...snapshot, baseSha: base.commit };
        const result = accepted(await acceptRunReport(report, deps));

        assert.equal(result.status, 'completed');
        assert.deepEqual(result.report?.evidence.reviewSnapshot, snapshot);
        assert.equal(
          (await submitReview({ ...assignment.submission, key: 'unrequested-repeat' }, deps))
            .outcome,
          'rejected',
        );
      } finally {
        await coordinator.stop();
      }
    });
  },
);
await test(
  'migration eight backfills a baseline event for existing queued jobs without launching or adopting workers',
  options,
  async () => {
    await fixture(async (context) => {
      const { job } = await prepare(context);
      context.context.opened.store.close();
      const raw = new DatabaseSync(join(context.context.state, 'state.sqlite'));

      try {
        raw.exec(
          'DROP TABLE review_follow_ups; DROP TABLE review_automation; DROP TABLE ci_requests; DROP TABLE ci_targets; DROP TABLE ci_budgets; DROP TABLE implementation_handoffs; DROP TABLE run_reconciliations; DROP TABLE runtime_input_retries; DROP TABLE run_cursors; DROP TABLE run_events; DROP TABLE run_cancellations; DROP TABLE run_resumes; DROP TABLE run_responses; DROP TABLE run_reports; DROP TABLE run_controls; DELETE FROM state_migrations WHERE version>=8; PRAGMA user_version=7;',
        );
      } finally {
        raw.close();
      }

      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: context.context.state,
      });

      assert.ok(reopened.outcome === 'opened', JSON.stringify(reopened));

      try {
        const page = reopened.runs.events({
          schemaVersion: 1,
          jobId: job.job.id,
          after: 0,
          limit: 100,
          waitMs: 0,
        });

        assert.ok(page.outcome === 'completed');
        assert.equal(page.value.events[0]?.kind, 'baseline');
        assert.equal(saved(job.job.id, { runs: reopened.runs }).status, 'queued');

        const handoff = reopened.handoffs.find(job.job.id);

        assert.ok(handoff.outcome === 'completed');
        assert.equal(handoff.value, null);
        assert.equal(context.launches.length, 0);
      } finally {
        reopened.store.close();
      }
    });
  },
);

await test(
  'report collection returns a validated proposal envelope and still requires normal coordinator acceptance',
  options,
  async () => {
    await fixture(async (context) => {
      const { deps, coordinator, job, proposal } = await prepare(context);
      coordinator.start();
      await coordinator.idle();

      try {
        const result = await collectRunReport(
          { schemaVersion: 1, jobId: job.job.id, key: 'collected' },
          {
            runs: deps.runs,
            reports: {
              async read({ run, prompt }) {
                assert.equal(run.job.attempt.id, job.attempt.id);
                assert.equal(prompt, context.prompts[0]?.text);

                return completed(proposal);
              },
            },
          },
        );

        assert.ok(result.outcome === 'completed', JSON.stringify(result));
        assert.equal(saved(job.job.id, deps).report, null);

        const acceptedReport = accepted(await acceptRunReport(result.value, deps));

        assert.equal(acceptedReport.status, 'completed');
        assert.equal(acceptedReport.cleanup.state, 'retained');

        const malformed = await collectRunReport(
          { schemaVersion: 1, jobId: job.job.id, key: 'malformed' },
          {
            runs: deps.runs,
            reports: { read: async () => completed({ summary: 'Not a report' }) },
          },
        );

        assert.equal(malformed.outcome, 'rejected');

        const cancelled = new AbortController();
        const interrupted = await collectRunReport(
          { schemaVersion: 1, jobId: job.job.id, key: 'cancelled' },
          {
            runs: deps.runs,
            reports: {
              read: async () => {
                cancelled.abort();

                return completed(proposal);
              },
            },
          },
          cancelled.signal,
        );

        assert.ok(interrupted.outcome === 'rejected' && interrupted.error.code === 'cancelled');
      } finally {
        await coordinator.stop();
      }
    });
  },
);
