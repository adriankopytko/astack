import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import {
  submitImplementation,
  cancelRun,
  requestCleanup,
  executeCleanup,
  createWorktreeGit,
  nodeProcessRunner,
  type StateWriteResult,
  type CleanupDependencies,
  type ServiceJob,
} from '../src/index.js';
import { fixture } from './support/implementation.js';
import { git, gitPath } from './support/service.js';
const options = { timeout: 90000 };
function saved<T>(result: StateWriteResult<T>) {
  assert.ok(result.outcome === 'persisted', JSON.stringify(result));

  return result.value;
}

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
async function setup(f: Fixture) {
  const submission = await f.prepare();
  const job = saved(await submitImplementation(submission, f.deps)).job;
  const cancel = {
    schemaVersion: 1 as const,
    jobId: job.job.id,
    key: 'cleanup-cancel',
    interrupt: false,
  };
  const opened = f.context.opened;
  const deps: CleanupDependencies = {
    cleanups: opened.cleanups,
    runs: opened.runs,
    cwd: f.context.state,
    now: () => 2000,
    worktrees: {
      ...f.deps,
      store: opened.worktrees,
      managedRoot: join(f.context.state, 'worktrees'),
      effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
      nextId: () => 'cancel-cleanup-operation',
    },
  };
  const cancelDeps = {
    runs: opened.runs,
    workerControl: { interrupt: async () => assert.fail('No worker was launched') },
  };

  return { job, cancel, deps, cancelDeps, opened };
}

function resolved(f: Fixture, job: ServiceJob) {
  const attempt = f.context.opened.store.inspectRecord({
    schemaVersion: 1,
    entity: 'attempt',
    id: job.attempt.id,
  });

  assert.ok(attempt.outcome === 'completed' && attempt.value?.entity === 'attempt');

  return attempt.value.resolvedAt;
}

await test(
  'never-claimed cancellation resolves the exact launch locally and permits ordinary owned cleanup without fabricating a worker claim',
  options,
  async () => {
    await fixture(async (f) => {
      const c = await setup(f);
      const run = saved(await cancelRun(c.cancel, c.cancelDeps));

      assert.equal(run.control.phase, 'cancelled');
      assert.equal(run.job.entry.claim, null);
      assert.equal(run.job.entry.observation, null);
      assert.equal(run.job.effect.state, 'cancelled');
      assert.equal(run.job.effect.claim?.owner, 'local-cancellation');
      assert.notEqual(resolved(f, c.job), null);
      assert.deepEqual(saved(await cancelRun(c.cancel, c.cancelDeps)), run);

      const plan = saved(
        requestCleanup(
          {
            schemaVersion: 1,
            jobId: c.job.job.id,
            key: 'cancel-cleanup',
            notBefore: 0,
            publication: 'not_required',
          },
          c.deps,
        ),
      );
      const complete = saved(
        await executeCleanup(
          { schemaVersion: 1, jobId: c.job.job.id, expectedRevision: plan.revision },
          c.deps,
        ),
      );

      assert.equal(complete.phase, 'completed');
      assert.equal(git(f.context.sources[0]!, 'rev-parse', plan.branch), plan.commit);
      assert.equal(f.launches.length, 0);
    });
  },
);

await test(
  'an explicit repeat settles legacy unclaimed cancellation once; inspection never heals it',
  options,
  async () => {
    await fixture(async (f) => {
      const c = await setup(f);
      saved(await cancelRun(c.cancel, c.cancelDeps));
      const raw = new DatabaseSync(join(f.context.state, 'state.sqlite'));

      try {
        // Reproduce the old cancellation representation without changing its saved request or control.
        raw.exec('BEGIN IMMEDIATE');
        raw.prepare('DELETE FROM results WHERE attempt_id=?').run(c.job.attempt.id);
        raw.prepare('UPDATE attempts SET resolved_at=NULL WHERE id=?').run(c.job.attempt.id);
        raw
          .prepare(
            "UPDATE effects SET state='pending', claim_owner=NULL, claim_token=NULL, claimed_at=NULL, expires_at=NULL, evidence=NULL WHERE id=?",
          )
          .run(c.job.entry.effectId);
        raw.exec('COMMIT');
      } finally {
        raw.close();
      }

      const inspected = c.opened.runs.inspect(c.job.job.id);

      assert.ok(inspected.outcome === 'completed' && inspected.value);
      assert.equal(inspected.value.control.phase, 'cancelled');
      assert.equal(inspected.value.job.effect.state, 'pending');
      assert.equal(resolved(f, c.job), null);

      const settled = await cancelRun(c.cancel, c.cancelDeps);
      const run = saved(settled);

      assert.equal(settled.outcome === 'persisted' && settled.disposition, 'updated');
      assert.equal(run.job.effect.state, 'cancelled');
      assert.notEqual(resolved(f, c.job), null);

      const events = c.opened.runs.events({
        schemaVersion: 1,
        jobId: c.job.job.id,
        after: 0,
        limit: 100,
        waitMs: 0,
      });
      const repeated = await cancelRun(c.cancel, c.cancelDeps);

      assert.equal(repeated.outcome === 'persisted' && repeated.disposition, 'existing');
      assert.deepEqual(
        c.opened.runs.events({
          schemaVersion: 1,
          jobId: c.job.job.id,
          after: 0,
          limit: 100,
          waitMs: 0,
        }),
        events,
      );
      assert.equal(f.launches.length, 0);
    });
  },
);

await test(
  'a separately claimed launch remains unresolved and cannot be cleared by cancellation or cleanup',
  options,
  async () => {
    await fixture(async (f) => {
      const c = await setup(f);
      saved(
        c.opened.store.claimEffect({
          schemaVersion: 1,
          effectId: c.job.entry.effectId,
          owner: 'independent-controller',
          token: 'unknown-original-launch',
          leaseMs: 1000,
        }),
      );
      const run = saved(await cancelRun(c.cancel, c.cancelDeps));

      assert.equal(run.job.entry.claim, null);
      assert.equal(run.job.effect.state, 'pending');
      assert.equal(run.job.effect.claim?.token, 'unknown-original-launch');
      assert.equal(resolved(f, c.job), null);

      assert.equal(run.control.phase, 'cancel_requested');

      const cleanup = requestCleanup(
        {
          schemaVersion: 1,
          jobId: c.job.job.id,
          key: 'blocked-cleanup',
          notBefore: 0,
          publication: 'not_required',
        },
        c.deps,
      );

      assert.ok(cleanup.outcome === 'rejected' && cleanup.error.code === 'cleanup_blocked');
      assert.equal(resolved(f, c.job), null);

      await access(c.deps.worktrees.managedRoot);

      assert.equal(f.launches.length, 0);
    });
  },
);

await test(
  'failed cancellation event persistence rolls back effect resolution, terminal result and cancellation together',
  options,
  async () => {
    await fixture(async (f) => {
      const c = await setup(f);
      const raw = new DatabaseSync(join(f.context.state, 'state.sqlite'));

      try {
        raw.exec(
          "CREATE TRIGGER refuse_cancel_event BEFORE INSERT ON run_events WHEN json_extract(NEW.data,'$.kind')='cancelled' BEGIN SELECT RAISE(ABORT,'fixture cancellation event'); END;",
        );
        const rejected = await cancelRun(c.cancel, c.cancelDeps);

        assert.equal(rejected.outcome, 'rejected');
        assert.equal(resolved(f, c.job), null);
        assert.deepEqual(c.opened.runs.cancellation(c.job.job.id, c.cancel.key), {
          schemaVersion: 1,
          outcome: 'completed',
          value: null,
        });

        const current = c.opened.service.read(c.job.job.id);

        assert.ok(current.outcome === 'completed' && current.value);
        assert.equal(current.value.effect.state, 'pending');
        assert.equal(current.value.effect.claim, null);
        assert.equal(current.value.entry.control, undefined);
      } finally {
        raw.exec('DROP TRIGGER refuse_cancel_event');
        raw.close();
      }

      assert.equal(saved(await cancelRun(c.cancel, c.cancelDeps)).job.effect.state, 'cancelled');
      assert.notEqual(resolved(f, c.job), null);
    });
  },
);
