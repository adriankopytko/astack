import { stateResultSchema } from '../../contracts/state.js';
import type { RunCancellation } from '../../contracts/runs.js';
import type { ServiceJob } from '../../contracts/service.js';
import { configurationDigest } from '../../core/configuration.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { runControl } from './run-events.js';
import { recordResultTransaction } from './store.js';

/** Local cancellation settlement only: an execution claim or uncertain effect never qualifies. */
export function settleUnclaimedCancellation(
  db: StateDatabase,
  job: ServiceJob,
  cancellation: RunCancellation,
): boolean {
  if (
    runControl(db, job.job.id).phase !== 'cancelled' ||
    job.entry.claim !== null ||
    job.entry.observation !== null ||
    cancellation.jobId !== job.job.id ||
    cancellation.attemptId !== job.attempt.id ||
    db.statement('SELECT id FROM results WHERE attempt_id=?').get(job.attempt.id)
  ) {
    return false;
  }

  const effects = db
    .statement('SELECT id,kind,effect_key,state,claim_token FROM effects WHERE attempt_id=?')
    .all(job.attempt.id);
  const effect = effects[0];

  if (
    effects.length !== 1 ||
    !effect ||
    effect.id !== job.entry.effectId ||
    effect.kind !== 'worker-launch' ||
    effect.effect_key !== 'initial' ||
    effect.state !== 'pending' ||
    effect.claim_token !== null
  ) {
    return false;
  }

  const digest = configurationDigest({ attemptId: job.attempt.id });
  const evidence = {
    source: 'unclaimed-run-cancellation',
    jobId: job.job.id,
    attemptId: job.attempt.id,
    effectId: job.entry.effectId,
    cancellationKey: cancellation.key,
  };
  // Claim the local resolution, never worker capacity or provider execution. The entry remains unclaimed.
  const claimedAt = Math.min(cancellation.createdAt, Number.MAX_SAFE_INTEGER - 1);
  db.statement(
    "UPDATE effects SET state='cancelled', claim_owner=?, claim_token=?, claimed_at=?, expires_at=?, evidence=? WHERE id=? AND state='pending' AND claim_token IS NULL",
  ).run(
    'local-cancellation',
    `unclaimed-cancellation-${digest}`,
    claimedAt,
    claimedAt + 1,
    canonicalJson(evidence),
    job.entry.effectId,
  );
  const result = stateResultSchema.parse({
    id: `unclaimed-cancellation-result-${digest}`,
    attemptId: job.attempt.id,
    outcome: 'cancelled',
    createdAt: cancellation.createdAt,
    evidence,
  });

  return recordResultTransaction(db, result).disposition === 'created';
}
