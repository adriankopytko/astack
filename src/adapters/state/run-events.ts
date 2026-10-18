import { stateResultSchema } from '../../contracts/state.js';
import { runControlSchema, type RunControl } from '../../contracts/run-control.js';
import { runEventSchema, type RunEvent } from '../../contracts/runs.js';
import type { ServiceJob } from '../../contracts/service.js';
import { canonicalJson, type StateDatabase } from './database.js';
export const initialRunControl: RunControl = { phase: 'active', revision: 0, reportId: null };
export function runControl(db: StateDatabase, jobId: string): RunControl {
  const saved = db.get(runControlSchema, 'SELECT data FROM run_controls WHERE job_id=?', jobId);

  if (saved) {
    return saved;
  }

  const legacy = db.get(
    stateResultSchema,
    'SELECT results.data FROM results JOIN service_entries ON results.attempt_id=service_entries.attempt_id WHERE service_entries.job_id=?',
    jobId,
  );

  return legacy ? { phase: legacy.outcome, revision: 1, reportId: null } : { ...initialRunControl };
}

export function saveRunControl(db: StateDatabase, jobId: string, control: RunControl) {
  db.statement(
    'INSERT INTO run_controls(job_id,data) VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data',
  ).run(jobId, canonicalJson(runControlSchema.parse(control)));
}

export function appendRunEvent(
  db: StateDatabase,
  job: ServiceJob,
  kind: RunEvent['kind'],
  now: number,
  detail: RunEvent['detail'],
) {
  const event = runEventSchema.omit({ id: true }).parse({
    projectId: job.job.projectId,
    jobId: job.job.id,
    attemptId: job.attempt.id,
    kind,
    createdAt: now,
    detail,
  });
  db.statement('INSERT INTO run_events(project_id,job_id,attempt_id,data) VALUES (?,?,?,?)').run(
    event.projectId,
    event.jobId,
    event.attemptId,
    canonicalJson(event),
  );
}
