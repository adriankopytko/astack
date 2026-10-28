import { hookPrerequisitesReady } from './hook-evidence.js';
import { isDeepStrictEqual } from 'node:util';
import {
  hookRecordSchema,
  hookReconcileSchema,
  hookExcludeSchema,
  type HookRecord,
} from '../../contracts/hooks.js';
import {
  stateJobSchema,
  stateAttemptSchema,
  stateResourceIntentSchema,
} from '../../contracts/state.js';
import { worktreeRecordSchema } from '../../contracts/worktrees.js';
import { allocationRecordSchema } from '../../contracts/resources.js';
import { reviewTaskSchema } from '../../contracts/review-task.js';
import type { HookStore } from '../../ports/hooks.js';
import { configurationDigest } from '../../core/configuration.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { appendRunEvent, runControl } from './run-events.js';
export function createSqliteHookStore(db: StateDatabase, now: () => number): HookStore {
  const read = (id: string) =>
    db.get(hookRecordSchema, 'SELECT data FROM hook_invocations WHERE id=?', id);
  function source(record: HookRecord, launching = false) {
    const job =
      db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', record.request.jobId) ??
      stateFailure('run_not_found');
    const attempt =
      db.get(
        stateAttemptSchema,
        'SELECT data FROM attempts WHERE id=?',
        record.request.attemptId,
      ) ?? stateFailure('state_not_found');
    const entry = db.statement('SELECT attempt_id FROM service_entries WHERE job_id=?').get(job.id);
    const worktree = db.get(
      worktreeRecordSchema,
      'SELECT data FROM managed_worktrees WHERE id=?',
      record.worktreeId,
    );

    if (
      !entry ||
      entry.attempt_id !== attempt.id ||
      attempt.jobId !== job.id ||
      job.projectId !== record.binding.projectId ||
      job.repositoryId !== record.binding.repositoryId ||
      job.checkoutId !== record.binding.checkoutId ||
      attempt.branch !== record.binding.branch ||
      record.binding.commit !== record.request.commit ||
      job.configuration?.policyDigest !== record.policyDigest ||
      !worktree ||
      worktree.phase !== 'ready' ||
      worktree.intent.checkoutId !== job.checkoutId ||
      worktree.intent.branch !== record.binding.branch ||
      worktree.intent.checkoutPath !== record.root ||
      !isDeepStrictEqual(worktree.location, record.location)
    ) {
      stateFailure('hook_blocked');
    }

    const review = reviewTaskSchema.safeParse(job.intent.task);

    if (
      job.operation !== 'delegate:implementer' &&
      !(job.operation === 'delegate:reviewer' && review.success)
    ) {
      stateFailure('hook_blocked');
    }

    if (
      job.operation === 'delegate:reviewer' &&
      review.success &&
      review.data.submission.resources.length === 0 &&
      record.request.phase !== 'verify'
    ) {
      stateFailure('hook_blocked');
    }

    if (
      launching &&
      !['verify', 'teardown'].includes(record.request.phase) &&
      (runControl(db, job.id).phase !== 'active' ||
        db.statement('SELECT resolved_at FROM attempts WHERE id=?').get(attempt.id)?.resolved_at !==
          null)
    ) {
      stateFailure('hook_blocked');
    }

    if (
      launching &&
      record.request.phase === 'verify' &&
      !['active', 'completed', 'failed', 'needs_decision'].includes(runControl(db, job.id).phase)
    ) {
      stateFailure('hook_blocked');
    }

    return { job, attempt };
  }

  function resources(record: HookRecord, exact: boolean) {
    for (const selected of record.request.allocations) {
      const allocation = db.get(
        allocationRecordSchema,
        'SELECT data FROM resource_allocations WHERE id=?',
        selected.id,
      );

      if (
        !allocation ||
        allocation.request.jobId !== record.request.jobId ||
        allocation.request.attemptId !== record.request.attemptId ||
        allocation.binding.checkoutId !== record.binding.checkoutId ||
        allocation.phase === 'released' ||
        (exact && allocation.revision !== selected.expectedRevision)
      ) {
        stateFailure('hook_blocked');
      }

      if (
        exact &&
        record.request.phase === 'start' &&
        (allocation.phase !== 'reserved' || allocation.startup)
      ) {
        stateFailure('hook_blocked');
      }
    }
  }

  function save(record: HookRecord) {
    const value = hookRecordSchema.parse(record);
    db.statement('UPDATE hook_invocations SET status=?,revision=?,data=? WHERE id=?').run(
      value.status,
      value.revision,
      canonicalJson(value),
      value.id,
    );
    appendRunEvent(
      db,
      {
        job: { id: value.request.jobId, projectId: value.binding.projectId },
        attempt: { id: value.request.attemptId },
      },
      'hook_changed',
      value.updatedAt,
      {
        hookId: value.id,
        phase: value.request.phase,
        status: value.status,
        revision: value.revision,
      },
    );

    return value;
  }

  return {
    read: (id) => db.read(() => read(id)),
    prepare(input) {
      return db.write(() => {
        const record = hookRecordSchema.parse(input);
        const old = read(record.id);

        if (old) {
          if (!isDeepStrictEqual(old.request, record.request)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        if (
          record.id !==
            `hook-${configurationDigest({ attemptId: record.request.attemptId, key: record.request.key })}` ||
          record.status !== 'prepared' ||
          record.revision !== 0 ||
          record.result ||
          record.reason ||
          record.shutdown ||
          record.writerExclusion
        ) {
          stateFailure('state_invalid_data');
        }

        source(record, true);
        resources(record, true);

        if (
          record.request.phase !== 'teardown' &&
          db
            .statement(
              "SELECT id FROM hook_invocations WHERE checkout_id=? AND status='unknown' AND json_extract(data,'$.shutdown') IS NULL LIMIT 1",
            )
            .get(record.binding.checkoutId)
        ) {
          stateFailure('hook_blocked');
        }

        const hold = stateResourceIntentSchema.parse({
          id: record.id,
          attemptId: record.request.attemptId,
          kind: 'hook',
          key: record.id,
          createdAt: record.createdAt,
          handle: { hookId: record.id },
        });
        db.statement(
          'INSERT INTO resources(id,attempt_id,kind,resource_key,data) VALUES (?,?,?,?,?)',
        ).run(hold.id, hold.attemptId, hold.kind, hold.key, canonicalJson(hold));
        db.statement(
          'INSERT INTO hook_invocations(id,job_id,attempt_id,checkout_id,request_key,status,revision,data) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          record.id,
          record.request.jobId,
          record.request.attemptId,
          record.binding.checkoutId,
          record.request.key,
          record.status,
          0,
          canonicalJson(record),
        );
        save(record);

        return { value: record, disposition: 'created' };
      });
    },
    claim(id, expectedRevision) {
      return db.write(() => {
        const old = read(id) ?? stateFailure('state_not_found');

        if (old.revision !== expectedRevision || old.status !== 'prepared' || old.shutdown) {
          stateFailure('state_reconciliation_required');
        }

        source(old, true);
        resources(old, true);
        const value = save({
          ...old,
          status: 'executing',
          revision: old.revision + 1,
          updatedAt: now(),
        });

        return { value, disposition: 'updated' };
      });
    },
    finish(input, expectedRevision) {
      return db.write(() => {
        const value = hookRecordSchema.parse(input);
        const old = read(value.id) ?? stateFailure('state_not_found');

        if (
          old.status !== 'executing' ||
          old.revision !== expectedRevision ||
          value.revision !== old.revision + 1 ||
          !isDeepStrictEqual(
            {
              ...value,
              status: old.status,
              revision: old.revision,
              result: old.result,
              reason: old.reason,
              updatedAt: old.updatedAt,
              endpoints: old.endpoints,
            },
            old,
          ) ||
          ['prepared', 'executing'].includes(value.status)
        ) {
          stateFailure('state_conflict');
        }

        return { value: save(value), disposition: 'updated' };
      });
    },
    excludeWriter(input) {
      return db.write(() => {
        const request = hookExcludeSchema.parse(input);
        const old = read(request.id) ?? stateFailure('state_not_found');
        const evidence = {
          key: request.key,
          expectedRevision: request.expectedRevision,
          writersStopped: true as const,
        };

        if (old.writerExclusion) {
          if (!isDeepStrictEqual(old.writerExclusion, evidence)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        if (
          old.revision !== request.expectedRevision ||
          old.shutdown ||
          !['executing', 'unknown'].includes(old.status)
        ) {
          stateFailure('state_conflict');
        }

        const value = save({
          ...old,
          status: 'unknown',
          reason: 'process_uncertain',
          writerExclusion: evidence,
          revision: old.revision + 1,
          updatedAt: now(),
        });

        return { value, disposition: 'updated' };
      });
    },
    reconcile(input) {
      return db.write(() => {
        const request = hookReconcileSchema.parse(input);
        const old = read(request.id) ?? stateFailure('state_not_found');
        const shutdown = {
          key: request.key,
          expectedRevision: request.expectedRevision,
          writersStopped: true as const,
          servicesStopped: true as const,
        };

        if (old.shutdown) {
          if (!isDeepStrictEqual(old.shutdown, shutdown)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        if (old.revision !== request.expectedRevision) {
          stateFailure('state_conflict');
        }

        for (const allocation of old.request.allocations) {
          if (
            !db
              .statement("SELECT id FROM resource_allocations WHERE id=? AND phase='released'")
              .get(allocation.id)
          ) {
            stateFailure('resource_blocked');
          }
        }

        const value = save({
          ...old,
          status:
            old.status === 'executing'
              ? 'unknown'
              : old.status === 'prepared'
                ? 'cancelled'
                : old.status,
          reason:
            old.status === 'executing'
              ? 'process_uncertain'
              : old.status === 'prepared'
                ? 'cancelled'
                : old.reason,
          shutdown,
          revision: old.revision + 1,
          updatedAt: now(),
        });
        const result = db
          .statement(
            'UPDATE resources SET released_at=?,release_evidence=? WHERE id=? AND attempt_id=? AND released_at IS NULL',
          )
          .run(value.updatedAt, canonicalJson(shutdown), old.id, old.request.attemptId);

        if (result.changes !== 1) {
          stateFailure('state_conflict');
        }

        return { value, disposition: 'updated' };
      });
    },
    prerequisitesReady: (jobId) => db.read(() => hookPrerequisitesReady(db, jobId)),
    integrationReady(jobId) {
      return db.read(() => {
        const job = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', jobId);
        const task = reviewTaskSchema.safeParse(job?.intent.task);
        const entry = db
          .statement('SELECT attempt_id FROM service_entries WHERE job_id=?')
          .get(jobId);

        if (!job || !task.success || !entry || task.data.submission.resources.length === 0) {
          return false;
        }

        for (const key of task.data.submission.resources) {
          const allocation = db.get(
            allocationRecordSchema,
            'SELECT data FROM resource_allocations WHERE job_id=? AND attempt_id=? AND request_key=?',
            jobId,
            String(entry.attempt_id),
            key,
          );

          if (
            !allocation ||
            !['running', 'retained'].includes(allocation.phase) ||
            !allocation.startup ||
            allocation.endpointVerifiedAt === null
          ) {
            return false;
          }

          const hook = read(allocation.startup.controller);

          if (
            !hook ||
            hook.request.jobId !== jobId ||
            hook.request.attemptId !== entry.attempt_id ||
            hook.request.phase !== 'start' ||
            hook.status !== 'succeeded' ||
            hook.shutdown ||
            hook.binding.commit !== task.data.submission.commit ||
            hook.policyDigest !== job.configuration?.policyDigest ||
            !hook.request.allocations.some((a) => a.id === allocation.id)
          ) {
            return false;
          }
        }

        return true;
      });
    },
  };
}
