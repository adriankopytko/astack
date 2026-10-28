import { stateJobSchema } from '../../contracts/state.js';
import { hookRecordSchema } from '../../contracts/hooks.js';
import { allocationRecordSchema } from '../../contracts/resources.js';
import { reviewTaskSchema } from '../../contracts/review-task.js';
import type { StateDatabase } from './database.js';
/** Pure transaction-local dispatch evidence; no command or endpoint probes. */
export function hookPrerequisitesReady(db: StateDatabase, jobId: string): boolean {
  const job = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', jobId);
  const entry = db.statement('SELECT attempt_id FROM service_entries WHERE job_id=?').get(jobId);

  if (!job?.configuration || !entry) {
    return false;
  }

  if (
    db
      .statement(
        "SELECT id FROM hook_invocations WHERE checkout_id=? AND (status IN ('prepared','executing') OR (status='unknown' AND json_extract(data,'$.shutdown') IS NULL)) LIMIT 1",
      )
      .get(job.checkoutId)
  ) {
    return false;
  }

  const review = reviewTaskSchema.safeParse(job.intent.task);

  if (review.success && review.data.submission.resources.length === 0) {
    return true;
  }

  for (const phase of ['setup', 'start'] as const) {
    const command = job.configuration.effective.hooks[phase];

    if (command == null) {
      continue;
    }

    const hook = db.get(
      hookRecordSchema,
      "SELECT data FROM hook_invocations WHERE job_id=? AND attempt_id=? AND status='succeeded' AND json_extract(data,'$.request.phase')=? AND json_extract(data,'$.command')=? AND json_extract(data,'$.policyDigest')=? AND json_extract(data,'$.shutdown') IS NULL ORDER BY rowid DESC LIMIT 1",
      jobId,
      String(entry.attempt_id),
      phase,
      command,
      job.configuration.policyDigest,
    );

    if (
      !hook ||
      hook.binding.commit !==
        db
          .statement("SELECT json_extract(data,'$.commit') AS sha FROM attempts WHERE id=?")
          .get(String(entry.attempt_id))?.sha
    ) {
      return false;
    }

    if (phase === 'start') {
      for (const ref of hook.request.allocations) {
        const allocation = db.get(
          allocationRecordSchema,
          'SELECT data FROM resource_allocations WHERE id=?',
          ref.id,
        );

        if (
          !allocation ||
          !['running', 'retained'].includes(allocation.phase) ||
          allocation.startup?.controller !== hook.id ||
          allocation.endpointVerifiedAt === null
        ) {
          return false;
        }
      }
    }
  }

  return true;
}
