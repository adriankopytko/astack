import { stateAttemptSchema, stateJobSchema, stateResultSchema } from '../../contracts/state.js';
import { configurationDigest } from '../../core/configuration.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { recordResultTransaction } from './store.js';

/** Host publication domain only; callers validate receipts and hold the writer-excluded transaction. */
export function completePublicationAttempt(
  db: StateDatabase,
  input: {
    jobId: string;
    attemptId: string;
    operation: 'implementation-handoff' | 'review-result-publication';
    projectId: string;
    repositoryId: string;
    checkoutId: string;
    commit: string;
    branch: string;
    effectIds: string[];
    createdAt: number;
    sourceJobId: string;
    sourceReportId: string;
  },
) {
  const job = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', input.jobId);
  const attempt = db.get(
    stateAttemptSchema,
    'SELECT data FROM attempts WHERE id=?',
    input.attemptId,
  );

  if (
    !job ||
    !attempt ||
    job.requester !== 'local-host' ||
    job.operation !== input.operation ||
    job.projectId !== input.projectId ||
    job.repositoryId !== input.repositoryId ||
    job.checkoutId !== input.checkoutId ||
    attempt.jobId !== job.id ||
    attempt.commit !== input.commit ||
    attempt.branch !== input.branch ||
    job.intent.sourceJobId !== input.sourceJobId ||
    job.intent.sourceReportId !== input.sourceReportId
  ) {
    return stateFailure('state_conflict');
  }

  const effects = db
    .statement('SELECT id,state FROM effects WHERE attempt_id=? ORDER BY id')
    .all(attempt.id);

  if (
    effects.length !== input.effectIds.length ||
    new Set(input.effectIds).size !== input.effectIds.length ||
    effects.some(
      (effect) => !input.effectIds.includes(String(effect.id)) || effect.state !== 'confirmed',
    )
  ) {
    return stateFailure('state_reconciliation_required');
  }

  const result = stateResultSchema.parse({
    id: `host-publication-result-${configurationDigest({ attemptId: attempt.id })}`,
    attemptId: attempt.id,
    outcome: 'completed',
    createdAt: input.createdAt,
    evidence: {
      kind: 'host-publication-completed',
      operation: input.operation,
      sourceJobId: input.sourceJobId,
      sourceReportId: input.sourceReportId,
      commit: input.commit,
      effectIds: input.effectIds,
    },
  });
  const existing = db.get(
    stateResultSchema,
    'SELECT data FROM results WHERE attempt_id=?',
    attempt.id,
  );

  if (existing) {
    const resolved = db
      .statement('SELECT resolved_at FROM attempts WHERE id=?')
      .get(attempt.id)?.resolved_at;

    if (canonicalJson(existing) !== canonicalJson(result) || resolved !== existing.createdAt) {
      return stateFailure('state_conflict');
    }
  }

  return recordResultTransaction(db, result).disposition === 'created';
}
