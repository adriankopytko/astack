import { cleanupPlanSchema, type CleanupPlan } from '../../contracts/cleanup.js';
import { stateAttemptSchema, stateJobSchema } from '../../contracts/state.js';
import { worktreeRecordSchema, type WorktreeRecord } from '../../contracts/worktrees.js';
import { handoffRecordSchema } from '../../contracts/handoff.js';
import { reviewResultPublicationSchema } from '../../contracts/review-results.js';
import { type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { runControl } from './run-events.js';
import { readAcceptedRunReport } from './run-report-codec.js';

export function readCleanup(db: StateDatabase, jobId: string) {
  return db.get(cleanupPlanSchema, 'SELECT data FROM cleanup_plans WHERE job_id=?', jobId);
}

/** Transactional saved authority, independent from provider observations and review readiness. */
export function assertCleanupSource(db: StateDatabase, plan: CleanupPlan, publication = false) {
  const job = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', plan.request.jobId);
  const entry = db
    .statement('SELECT attempt_id FROM service_entries WHERE job_id=?')
    .get(plan.request.jobId);
  const control = runControl(db, plan.request.jobId);
  const attempt = db.get(
    stateAttemptSchema,
    'SELECT data FROM attempts WHERE id=?',
    plan.attemptId,
  );
  const worktree = db.get(
    worktreeRecordSchema,
    'SELECT data FROM managed_worktrees WHERE id=?',
    plan.worktreeId,
  );
  const report =
    plan.reportId === null
      ? null
      : readAcceptedRunReport(db, 'SELECT data FROM run_reports WHERE id=?', plan.reportId);

  if (
    !job ||
    !entry ||
    !worktree ||
    !attempt ||
    attempt.jobId !== plan.request.jobId ||
    attempt.branch !== plan.branch ||
    (plan.reportId !== null && report === null) ||
    (report === null && attempt.commit !== plan.commit) ||
    job.projectId !== plan.projectId ||
    job.repositoryId !== plan.repositoryId ||
    job.checkoutId !== plan.checkoutId ||
    entry.attempt_id !== plan.attemptId ||
    control.reportId !== plan.reportId ||
    !['completed', 'failed', 'cancelled'].includes(control.phase) ||
    !['delegate:implementer', 'delegate:reviewer'].includes(job.operation) ||
    worktree.intent.projectId !== plan.projectId ||
    worktree.intent.repositoryId !== plan.repositoryId ||
    worktree.intent.checkoutId !== plan.checkoutId ||
    worktree.intent.branch !== plan.branch ||
    (report &&
      (report.jobId !== job.id ||
        report.attemptId !== plan.attemptId ||
        report.evidence.commit !== plan.commit))
  ) {
    stateFailure('state_conflict');
  }

  // Another delegated task must have its own cleanup/retention authority, even if terminal.
  if (
    db
      .statement(
        "SELECT id FROM jobs WHERE checkout_id=? AND id<>? AND operation IN ('delegate:implementer','delegate:reviewer') LIMIT 1",
      )
      .get(plan.checkoutId, job.id)
  ) {
    stateFailure('state_conflict');
  }

  if (publication) {
    const handoff = db.get(
      handoffRecordSchema,
      "SELECT data FROM implementation_handoffs WHERE job_id=? AND phase!='abandoned' ORDER BY rowid DESC LIMIT 1",
      job.id,
    );
    const review =
      plan.reportId === null
        ? null
        : db.get(
            reviewResultPublicationSchema,
            'SELECT data FROM review_result_publications WHERE report_id=?',
            plan.reportId,
          );
    const confirmed =
      (handoff?.phase === 'accepted' &&
        handoff.request.reportId === plan.reportId &&
        handoff.source.headCommit === plan.commit) ||
      (review !== null &&
        db
          .statement("SELECT id FROM effects WHERE id=? AND state='confirmed'")
          .get(review.effectId) !== undefined);

    if (
      (handoff && handoff.phase !== 'accepted') ||
      (review && !confirmed) ||
      (plan.request.publication === 'required' && !confirmed)
    ) {
      stateFailure('cleanup_blocked');
    }
  }

  return { job, worktree };
}

export function assertCleanupRemoval(
  db: StateDatabase,
  authority: { jobId: string; revision: number },
  record: WorktreeRecord,
  head: string,
  now: number,
) {
  const plan = readCleanup(db, authority.jobId);

  if (
    !plan ||
    plan.phase !== 'started' ||
    plan.revision !== authority.revision ||
    plan.worktreeId !== record.intent.id ||
    plan.commit !== head ||
    now < plan.request.notBefore
  ) {
    stateFailure('cleanup_blocked');
  }

  assertCleanupSource(db, plan, true);
}
