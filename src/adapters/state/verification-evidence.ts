import { selectionFromApproval } from '../../core/verification.js';
import { isDeepStrictEqual } from 'node:util';
import { verificationRecordSchema, type VerificationRecord } from '../../contracts/verification.js';
import { hookRecordSchema } from '../../contracts/hooks.js';
import { stateJobSchema } from '../../contracts/state.js';
import { handoffRecordSchema, type HandoffSource } from '../../contracts/handoff.js';
import { configurationDigest } from '../../core/configuration.js';
import { readAcceptedRunReport } from './run-report-codec.js';
import { runControl } from './run-events.js';
import { stateFailure } from './errors.js';
import type { StateDatabase } from './database.js';
export function assertVerificationSource(db: StateDatabase, record: VerificationRecord) {
  const job = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', record.request.jobId);
  const report = readAcceptedRunReport(
    db,
    'SELECT data FROM run_reports WHERE id=?',
    record.request.reportId,
  );
  const entry = db
    .statement('SELECT attempt_id FROM service_entries WHERE job_id=?')
    .get(record.request.jobId);
  const control = runControl(db, record.request.jobId);

  if (
    !job ||
    !report ||
    !entry ||
    job.operation !== 'delegate:implementer' ||
    control.phase !== 'completed' ||
    control.reportId !== report.id ||
    report.jobId !== job.id ||
    report.attemptId !== record.source.attemptId ||
    entry.attempt_id !== record.source.attemptId ||
    report.evidence.commit !== record.source.headCommit ||
    report.evidence.inputDigest !== record.source.inputDigest ||
    configurationDigest(report) !== record.reportDigest ||
    !isDeepStrictEqual(report.request.artifacts, record.artifacts) ||
    job.projectId !== record.source.projectId ||
    job.repositoryId !== record.source.repositoryId ||
    job.checkoutId !== record.source.checkoutId ||
    job.configuration?.policyDigest !== record.policyDigest ||
    job.configuration.role !== record.role
  ) {
    stateFailure('verification_blocked');
  }

  const selection = job.configuration.verification
    ? selectionFromApproval(job.configuration.verification, record.role, record.request)
    : null;
  const plan = record.checks.map(({ name, kind, definitionDigest, commandDigest }) => ({
    name,
    kind,
    definitionDigest,
    commandDigest,
  }));

  if (
    !selection ||
    selection.digest !== record.selectionDigest ||
    selection.maxAgeMs !== record.maxAgeMs ||
    !isDeepStrictEqual(selection.checks, plan) ||
    record.checks.some(
      (c) => c.hookKey !== `verify-check-${configurationDigest({ id: record.id, name: c.name })}`,
    )
  ) {
    stateFailure('verification_blocked');
  }

  return { job, attempt: { id: record.source.attemptId } };
}

export function assertPassedChecks(db: StateDatabase, record: VerificationRecord) {
  for (const check of record.checks) {
    const hook = check.hookId
      ? db.get(hookRecordSchema, 'SELECT data FROM hook_invocations WHERE id=?', check.hookId)
      : null;

    if (
      check.outcome !== 'passed' ||
      !hook ||
      hook.status !== 'succeeded' ||
      hook.createdAt < record.createdAt ||
      hook.request.jobId !== record.request.jobId ||
      hook.request.attemptId !== record.source.attemptId ||
      hook.request.phase !== 'verify' ||
      hook.request.verificationCheck !== check.name ||
      hook.request.key !== check.hookKey ||
      hook.request.commit !== record.source.headCommit ||
      hook.policyDigest !== record.policyDigest ||
      hook.commandDigest !== check.commandDigest ||
      hook.result === null ||
      configurationDigest(hook.result) !== check.resultDigest ||
      check.hookRevision === null ||
      hook.revision < check.hookRevision
    ) {
      stateFailure('verification_blocked');
    }
  }
}

export function assertFreshVerification(
  db: StateDatabase,
  id: string,
  source: HandoffSource,
  jobId: string,
  reportId: string,
  now: number,
) {
  const record =
    db.get(
      verificationRecordSchema,
      'SELECT data FROM implementation_verifications WHERE id=?',
      id,
    ) ?? stateFailure('verification_blocked');

  if (
    record.status !== 'passed' ||
    record.verifiedAt === null ||
    record.expiresAt === null ||
    now < record.verifiedAt ||
    now >= record.expiresAt ||
    record.request.jobId !== jobId ||
    record.request.reportId !== reportId ||
    !isDeepStrictEqual(record.source, source)
  ) {
    stateFailure('verification_blocked');
  }

  assertVerificationSource(db, record);
  assertPassedChecks(db, record);

  return record;
}

/** New claims only. Historical/claimed effects reconcile through their existing receipts. */
export function assertHandoffVerificationClaim(db: StateDatabase, attemptId: string, now: number) {
  const handoff = db.get(
    handoffRecordSchema,
    "SELECT data FROM implementation_handoffs WHERE json_extract(data,'$.publicationAttemptId')=?",
    attemptId,
  );

  if (!handoff) {
    return;
  }

  if (handoff.request.verification.source !== 'executed') {
    stateFailure('verification_blocked');
  }

  assertFreshVerification(
    db,
    handoff.request.verification.id,
    handoff.source,
    handoff.request.jobId,
    handoff.request.reportId,
    now,
  );
}
