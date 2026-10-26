import { isDeepStrictEqual } from 'node:util';
import { cleanupPlanSchema, type CleanupPlan } from '../../contracts/cleanup.js';
import type { CleanupStore } from '../../ports/cleanup.js';
import { configurationDigest } from '../../core/configuration.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { appendRunEvent } from './run-events.js';
import { assertCleanupSource, readCleanup } from './cleanup-evidence.js';

export function createSqliteCleanupStore(db: StateDatabase): CleanupStore {
  function save(plan: CleanupPlan) {
    const { job } = assertCleanupSource(db, plan);
    db.statement(
      'INSERT INTO cleanup_plans(job_id,id,checkout_id,phase,data) VALUES (?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET phase=excluded.phase,data=excluded.data',
    ).run(
      plan.request.jobId,
      plan.id,
      plan.checkoutId,
      plan.phase,
      canonicalJson(cleanupPlanSchema.parse(plan)),
    );
    appendRunEvent(
      db,
      { job, attempt: { id: plan.attemptId } },
      'cleanup_changed',
      plan.updatedAt,
      { cleanupId: plan.id, phase: plan.phase, reason: plan.reason, revision: plan.revision },
    );
  }

  return {
    read: (jobId) => db.read(() => readCleanup(db, jobId)),
    reserve(input) {
      return db.write(() => {
        const plan = cleanupPlanSchema.parse(input);
        const old = readCleanup(db, plan.request.jobId);

        if (old) {
          if (!isDeepStrictEqual(old.request, plan.request)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        if (
          plan.id !== `cleanup-${configurationDigest(plan.request.jobId)}` ||
          plan.phase !== 'requested' ||
          plan.revision !== 0 ||
          plan.reason !== null
        ) {
          stateFailure('state_invalid_data');
        }

        save(plan);

        return { value: plan, disposition: 'created' };
      });
    },
    transition(input) {
      return db.write(() => {
        const old = readCleanup(db, input.jobId) ?? stateFailure('state_not_found');

        if (
          old.revision !== input.expectedRevision ||
          ['completed', 'cancelled'].includes(old.phase)
        ) {
          stateFailure('state_conflict');
        }

        const allowed =
          old.phase === 'started'
            ? input.phase === 'completed' ||
              input.phase === 'blocked' ||
              (input.reconciliation === true && input.phase === 'requested')
            : (input.phase === 'started' && ['requested', 'blocked'].includes(old.phase)) ||
              ['suspended', 'cancelled', 'requested', 'blocked'].includes(input.phase);

        if (!allowed) {
          stateFailure('state_reconciliation_required');
        }

        if (input.phase === 'started') {
          assertCleanupSource(db, old, true);
        }

        if (input.phase === 'completed') {
          const { worktree } = assertCleanupSource(db, old);

          if (worktree.phase !== 'removed' || worktree.removalCommit !== old.commit) {
            stateFailure('state_conflict');
          }
        }

        const value = {
          ...old,
          phase: input.phase,
          reason: input.reason,
          revision: old.revision + 1,
          updatedAt: input.now,
        };
        save(value);

        return { value, disposition: 'updated' };
      });
    },
    authorize(plan) {
      return db.read(() => {
        const old = readCleanup(db, plan.request.jobId);

        if (!old || !isDeepStrictEqual(old, plan)) {
          stateFailure('state_conflict');
        }

        assertCleanupSource(db, plan, true);

        return null;
      });
    },
    list(input) {
      return db.read(() => {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
          stateFailure('invalid_request');
        }

        const rows = db
          .statement('SELECT data FROM cleanup_plans WHERE job_id>? ORDER BY job_id LIMIT ?')
          .all(input.after, input.limit + 1);
        const items = rows
          .slice(0, input.limit)
          .map((row) => db.data(cleanupPlanSchema, row) ?? stateFailure('state_invalid_data'));

        return {
          items,
          nextCursor: rows.length > input.limit ? items.at(-1)!.request.jobId : null,
        };
      });
    },
  };
}
