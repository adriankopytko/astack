import assert from 'node:assert/strict';
import { writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  requestCleanup,
  executeCleanup,
  inspectCleanup,
  controlCleanup,
  reconcileCleanup,
  createCleanupExecutor,
  finishImplementation,
  reconcileRun,
  createWorktreeGit,
  nodeProcessRunner,
  openSqliteState,
  acquireCoordinatorOwnership,
  executeLocalCleanup,
  submitImplementation,
  implementationTaskSchema,
  cleanupWriteResultSchema,
  type CleanupDependencies,
  type StateWriteResult,
} from '../src/index.js';
import { suspendCleanupExecutor } from '../src/application/automatic-cleanup.js';
import { completed, rejected } from '../src/contracts/operation-result.js';
import type { RunShutdownVerifier } from '../src/ports/runs.js';
import { fixture, type HandoffFixture } from './support/handoff.js';
import { git, gitPath } from './support/service.js';

const options = { timeout: 120000 };
function saved<T>(result: StateWriteResult<T>): T {
  assert.ok(result.outcome === 'persisted', JSON.stringify(result));

  return result.value;
}

function setup(f: HandoffFixture) {
  const opened = f.context.context.opened;
  let now = 2000;
  let sequence = 0;
  let absent = true;
  const shutdown: RunShutdownVerifier = {
    async verify({ run, request }) {
      if (!absent) {
        return rejected('runtime_conflict', 'Fixture worker still present');
      }

      const handle = run.job.entry.observation?.handle;

      assert.ok(handle);

      return completed({
        request,
        source: 'host-attestation',
        workerHandle: handle,
        resourceBindings: [
          { id: `worker:${run.job.attempt.id}`, kind: 'worker', key: run.job.attempt.id, handle },
        ],
        verifiedAt: now,
        providerEvidence: { absent: true },
        releasedResourceIds: [],
      });
    },
  };
  const deps: CleanupDependencies = {
    cleanups: opened.cleanups,
    runs: opened.runs,
    cwd: f.context.context.state,
    shutdown,
    now: () => now,
    worktrees: {
      ...f.context.deps,
      store: opened.worktrees,
      managedRoot: join(f.context.context.state, 'worktrees'),
      effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
      nextId: (kind) => `${kind}-cleanup-${++sequence}`,
      now: () => now,
    },
  };
  function plan() {
    const result = inspectCleanup({ schemaVersion: 1, jobId: f.job.job.id }, deps);

    assert.ok(result.outcome === 'completed' && result.value, JSON.stringify(result));

    return result.value;
  }

  function request(extra: Record<string, unknown> = {}) {
    return requestCleanup(
      { schemaVersion: 1, jobId: f.job.job.id, key: 'cleanup', notBefore: 2000, ...extra },
      deps,
    );
  }

  async function reconcile() {
    const run = opened.runs.inspect(f.job.job.id);

    assert.ok(run.outcome === 'completed' && run.value);

    return saved(
      await reconcileRun(
        {
          schemaVersion: 1,
          jobId: f.job.job.id,
          key: 'shutdown',
          attemptId: f.job.attempt.id,
          launchId: 'fixture-launch',
          expectedRevision: run.value.control.revision,
          workerStopped: true,
          servicesStopped: true,
          writersStopped: true,
        },
        { runs: opened.runs, shutdown },
      ),
    );
  }

  async function execute(extra: Record<string, unknown> = {}) {
    return await executeCleanup(
      { schemaVersion: 1, jobId: f.job.job.id, expectedRevision: plan().revision, ...extra },
      deps,
    );
  }

  return {
    deps,
    plan,
    request,
    reconcile,
    execute,
    advance: (time: number) => {
      now = time;
    },
    present: (value: boolean) => {
      absent = !value;
    },
  };
}

await test(
  'cleanup preserves retained resources, ignored/untracked/dirty files and unpublished results before completing independently of review',
  options,
  async () => {
    await fixture(async (f) => {
      const c = setup(f);
      const first = saved(c.request());

      assert.equal(first.phase, 'requested');
      assert.equal(saved(c.request()).id, first.id);
      assert.equal(c.request({ key: 'different' }).outcome, 'rejected');
      assert.equal(saved(await c.execute()).reason, 'cleanup_blocked');

      saved(await finishImplementation(f.input, f.deps));

      assert.equal(saved(await c.execute()).reason, 'resources_retained');

      await c.reconcile();
      c.present(true);

      assert.equal(saved(await c.execute()).reason, 'shutdown_unverified');

      c.present(false);

      assert.equal(saved(await c.execute()).reason, 'ignored_files');

      await rm(join(f.root, f.artifact.path));
      await writeFile(join(f.root, 'untracked.txt'), 'preserve me');

      assert.equal(saved(await c.execute()).reason, 'dirty');

      await rm(join(f.root, 'untracked.txt'));
      await writeFile(join(f.root, 'result.txt'), 'uncommitted');

      assert.equal(saved(await c.execute()).reason, 'dirty');

      git(f.root, 'restore', 'result.txt');
      const complete = saved(await c.execute());

      assert.equal(complete.phase, 'completed');
      assert.equal(git(f.context.context.sources[0]!, 'rev-parse', f.job.entry.branch), f.head);

      await assert.rejects(access(f.root));

      assert.equal(saved(await c.execute()).revision, complete.revision);
      assert.equal(f.remote.postCalls, 1);
      assert.equal(f.inspect().record.followUpReview?.state, 'requested');

      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: f.context.context.state,
        mode: 'read-only',
      });

      assert.ok(reopened.outcome === 'opened');

      try {
        assert.deepEqual(reopened.cleanups.read(f.job.job.id), completed(complete));

        const events = reopened.runs.events({
          schemaVersion: 1,
          jobId: f.job.job.id,
          after: 0,
          limit: 100,
          waitMs: 0,
        });

        assert.ok(events.outcome === 'completed');
        assert.ok(
          events.value.events.some(
            (event) =>
              event.kind === 'cleanup_changed' &&
              event.detail &&
              typeof event.detail === 'object' &&
              !Array.isArray(event.detail) &&
              event.detail.phase === 'completed',
          ),
        );
      } finally {
        reopened.store.close();
      }
    });
  },
);

await test(
  'cleanup checks current commit, exact revision, cwd and all retained resources',
  options,
  async () => {
    await fixture(async (f) => {
      const c = setup(f);
      saved(await finishImplementation(f.input, f.deps));
      saved(c.request());
      await c.reconcile();
      await rm(join(f.root, f.artifact.path));

      assert.equal((await c.execute({ expectedRevision: 999 })).outcome, 'rejected');

      const inside = saved(
        await executeCleanup(
          { schemaVersion: 1, jobId: f.job.job.id, expectedRevision: c.plan().revision },
          { ...c.deps, cwd: f.root },
        ),
      );

      assert.equal(inside.reason, 'cleanup_cwd_inside_checkout');

      const held = f.context.context.opened.store.retainResource({
        schemaVersion: 1,
        resource: {
          id: 'custom-service',
          attemptId: f.job.attempt.id,
          kind: 'service',
          key: 'owned',
          createdAt: 2000,
          handle: { endpoint: 'fixture' },
        },
      });
      saved(held);

      assert.equal(saved(await c.execute()).reason, 'resources_retained');

      saved(
        f.context.context.opened.store.releaseResource({
          schemaVersion: 1,
          resourceId: 'custom-service',
          attemptId: f.job.attempt.id,
          evidence: { source: 'fixture', stopped: true },
        }),
      );
      const verifier = c.deps.shutdown!;
      c.deps.shutdown = {
        async verify(input, signal) {
          saved(
            controlCleanup(
              {
                schemaVersion: 1,
                jobId: f.job.job.id,
                expectedRevision: c.plan().revision,
                action: 'suspend',
              },
              c.deps,
            ),
          );

          return await verifier.verify(input, signal);
        },
      };

      const raced = await c.execute();

      assert.ok(raced.outcome === 'rejected' && raced.error.code === 'state_conflict');
      assert.equal(c.plan().phase, 'suspended');

      await access(f.root);

      c.deps.shutdown = verifier;
      saved(
        controlCleanup(
          {
            schemaVersion: 1,
            jobId: f.job.job.id,
            expectedRevision: c.plan().revision,
            action: 'resume',
          },
          c.deps,
        ),
      );
      await writeFile(join(f.root, 'result.txt'), 'different committed work');
      git(f.root, 'add', 'result.txt');
      git(f.root, 'commit', '-m', 'feat: different work');

      assert.equal(saved(await c.execute()).reason, 'cleanup_blocked');

      await access(f.root);

      assert.equal(
        f.context.context.opened.worktrees.forCheckout(f.job.job.checkoutId).outcome,
        'completed',
      );
      assert.equal(c.plan().commit, f.head);
    });
  },
);

await test(
  'uncertain removal keeps its claim, never replays by age, and reconciles absence without another Git write',
  options,
  async () => {
    await fixture(async (f) => {
      const c = setup(f);
      saved(await finishImplementation(f.input, f.deps));
      saved(c.request({ automatic: true }));
      await c.reconcile();
      await rm(join(f.root, f.artifact.path));
      const original = c.deps.worktrees.effects.remove.bind(c.deps.worktrees.effects);
      let calls = 0;
      c.deps.worktrees.effects.remove = async (...args) => {
        calls++;
        await original(...args);

        throw new Error('Fixture response lost after removal');
      };

      const pending = saved(await c.execute());

      assert.equal(pending.phase, 'started');
      assert.equal(calls, 1);
      assert.equal(
        controlCleanup(
          {
            schemaVersion: 1,
            jobId: f.job.job.id,
            action: 'resume',
            expectedRevision: pending.revision,
          },
          c.deps,
        ).outcome,
        'rejected',
      );

      c.advance(999999999);

      assert.equal((await c.execute()).outcome, 'rejected');

      const executor = createCleanupExecutor(c.deps, () => assert.fail('Executor failed'));
      executor.start();
      await executor.stop();

      assert.equal(calls, 1);
      assert.equal(
        (
          await reconcileCleanup(
            { schemaVersion: 1, jobId: f.job.job.id, expectedRevision: pending.revision },
            c.deps,
          )
        ).outcome,
        'rejected',
      );

      const reconciled = saved(
        await reconcileCleanup(
          {
            schemaVersion: 1,
            jobId: f.job.job.id,
            expectedRevision: pending.revision,
            writersStopped: true,
          },
          c.deps,
        ),
      );

      assert.equal(reconciled.phase, 'completed');
      assert.equal(calls, 1);
      assert.equal(git(f.context.context.sources[0]!, 'rev-parse', f.job.entry.branch), f.head);
    });
  },
);

await test(
  'claims block new checkout assignments; manual recovery after a pre-effect crash does not remove anything',
  options,
  async () => {
    await fixture(async (f) => {
      const c = setup(f);
      saved(await finishImplementation(f.input, f.deps));
      saved(c.request());
      await c.reconcile();
      await rm(join(f.root, f.artifact.path));
      const started = saved(
        c.deps.cleanups.transition({
          jobId: f.job.job.id,
          expectedRevision: 0,
          phase: 'started',
          reason: null,
          now: 2000,
        }),
      );
      const task = implementationTaskSchema.parse(f.job.job.intent.task);
      const competing = await submitImplementation(
        { ...task.submission, key: 'new-assignment', commit: f.head },
        f.context.deps,
      );

      assert.equal(competing.outcome, 'rejected');
      assert.equal((await c.execute()).outcome, 'rejected');

      const recovered = saved(
        await reconcileCleanup(
          {
            schemaVersion: 1,
            jobId: f.job.job.id,
            expectedRevision: started.revision,
            writersStopped: true,
          },
          c.deps,
        ),
      );

      assert.equal(recovered.phase, 'requested');

      await access(f.root);

      assert.equal(saved(await c.execute()).phase, 'completed');
    });
  },
);

async function eventually(check: () => boolean) {
  const until = Date.now() + 5000;

  while (!check()) {
    assert.ok(Date.now() < until, 'Timed out waiting for local cleanup executor');

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

await test(
  'automatic cleanup honors retention, suspends without executor authority, requires explicit resume, then uses ordinary removal',
  options,
  async () => {
    await fixture(async (f) => {
      const c = setup(f);
      saved(await finishImplementation(f.input, f.deps));
      saved(c.request({ automatic: true, notBefore: 2200 }));
      await c.reconcile();
      await rm(join(f.root, f.artifact.path));

      assert.equal(saved(await c.execute()).reason, 'retention');
      assert.equal(
        suspendCleanupExecutor(c.deps.cleanups, () => c.deps.now()).outcome,
        'completed',
      );
      assert.equal(c.plan().phase, 'suspended');

      c.advance(2200);
      const executor = createCleanupExecutor(c.deps, () => assert.fail('Executor failed'));
      executor.start();

      try {
        await new Promise((resolve) => setTimeout(resolve, 25));

        assert.equal(c.plan().phase, 'suspended');

        saved(
          controlCleanup(
            {
              schemaVersion: 1,
              jobId: f.job.job.id,
              expectedRevision: c.plan().revision,
              action: 'resume',
            },
            c.deps,
          ),
        );
        executor.wake();
        await eventually(() => c.plan().phase === 'completed');
      } finally {
        await executor.stop();
      }

      assert.equal(c.plan().phase, 'completed');
      assert.equal(f.remote.postCalls, 1);
    });
  },
);

await test(
  'offline cleanup respects coordinator ownership before effects or migration',
  options,
  async () => {
    await fixture(async (f) => {
      const lock = await acquireCoordinatorOwnership(f.context.context.state);

      try {
        const result = await executeLocalCleanup(
          'request',
          {},
          { stateDirectory: f.context.context.state, gitExecutable: '/nonexistent' },
        );

        assert.ok(
          result.outcome === 'rejected' && result.error.code === 'service_already_running',
          JSON.stringify(result),
        );
        assert.equal(f.remote.postCalls, 0);
      } finally {
        lock.release();
      }
    });
  },
);

await test(
  'running service suspends automatic requests without authority and executes them only after explicit enabled resume',
  options,
  async () => {
    const { startLocalService, requestLocalService } = await import('../src/index.js');
    await fixture(async (f) => {
      const c = setup(f);
      saved(await finishImplementation(f.input, f.deps));
      await c.reconcile();
      await rm(join(f.root, f.artifact.path));
      const disabled = await startLocalService({
        schemaVersion: 1,
        stateDirectory: f.context.context.state,
        gitExecutable: gitPath,
      });

      assert.ok(disabled.outcome === 'listening', JSON.stringify(disabled));

      try {
        const result = await requestLocalService(disabled.stateDirectory, {
          schemaVersion: 1,
          operation: 'cleanup_request',
          jobId: f.job.job.id,
          key: 'cleanup',
          notBefore: 0,
          automatic: true,
        });

        assert.ok(
          result.outcome === 'persisted' &&
            'phase' in result.value &&
            result.value.phase === 'suspended',
          JSON.stringify(result),
        );
        assert.equal(c.plan().phase, 'suspended');

        const resume = await requestLocalService(disabled.stateDirectory, {
          schemaVersion: 1,
          operation: 'cleanup_control',
          jobId: f.job.job.id,
          expectedRevision: c.plan().revision,
          action: 'resume',
        });

        assert.ok(resume.outcome === 'rejected' && resume.error.code === 'cleanup_blocked');
      } finally {
        await disabled.close();
      }

      const enabled = await startLocalService(
        { schemaVersion: 1, stateDirectory: f.context.context.state, gitExecutable: gitPath },
        { cleanup: true, cleanupShutdown: c.deps.shutdown! },
      );

      assert.ok(enabled.outcome === 'listening', JSON.stringify(enabled));

      try {
        assert.equal(c.plan().phase, 'suspended');

        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(new URL('../dist/cli/main.js', import.meta.url)),
            '--state-directory',
            enabled.stateDirectory,
            'cleanup',
            'resume',
            f.job.job.id,
            '--revision',
            String(c.plan().revision),
            '--json',
          ],
          { cwd: f.context.context.root, timeout: 15000 },
        );
        const result = cleanupWriteResultSchema.parse(JSON.parse(stdout));

        assert.equal(result.outcome, 'persisted', JSON.stringify(result));

        await eventually(() => c.plan().phase === 'completed');
      } finally {
        await enabled.close();
      }

      assert.equal(f.remote.postCalls, 1);
      assert.equal(c.plan().phase, 'completed');
    });
  },
);

await test(
  'manual cleanup can verify complete host shutdown attestations and explicitly retain unpublished work on its task branch',
  options,
  async () => {
    await fixture(async (f) => {
      const c = setup(f);
      saved(c.request({ publication: 'not_required' }));
      await rm(join(f.root, f.artifact.path));
      const run = c.deps.runs.inspect(f.job.job.id);

      assert.ok(run.outcome === 'completed' && run.value);

      const shutdown = {
        schemaVersion: 1,
        jobId: f.job.job.id,
        key: 'shutdown',
        attemptId: f.job.attempt.id,
        launchId: 'fixture-launch',
        expectedRevision: run.value.control.revision,
        workerStopped: true,
        servicesStopped: true,
        writersStopped: true,
      };

      assert.equal(
        (await c.execute({ shutdown: { ...shutdown, servicesStopped: false } })).outcome,
        'rejected',
      );
      assert.equal(
        saved(await c.execute({ shutdown: { ...shutdown, jobId: 'another-run' } })).reason,
        'shutdown_verifier_required',
      );

      const executor = createCleanupExecutor(c.deps, () => assert.fail('Executor failed'));
      executor.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await executor.stop();

      assert.equal(c.plan().phase, 'blocked');
      assert.equal(saved(await c.execute({ shutdown })).phase, 'completed');
      assert.equal(f.remote.postCalls, 0);
      assert.equal(git(f.context.context.sources[0]!, 'rev-parse', f.job.entry.branch), f.head);
    });
  },
);

await test(
  'allow-unpublished does not bypass a prepared or uncertain publication',
  options,
  async () => {
    await fixture(async (f) => {
      const c = setup(f);
      f.remote.pushMode = 'lost';
      await finishImplementation(f.input, f.deps);
      saved(c.request({ publication: 'not_required' }));

      assert.equal(saved(await c.execute()).reason, 'cleanup_blocked');
      assert.equal(f.inspect().record.phase, 'prepared');
      assert.equal(f.remote.pushCalls, 1);
      assert.equal(f.remote.postCalls, 0);

      await access(f.root);
    });
  },
);
