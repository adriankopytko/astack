import { implementationProgressSchema } from '../../contracts/implementation-task.js';
import { createHash } from 'node:crypto';
import {
  runViewSchema,
  acceptedRunReportSchema,
  runResponseSchema,
  runResumeSchema,
  runCancellationSchema,
  runEventSchema,
  runCursorSchema,
  type RunView,
  type RunCursor,
  type RunEventScope,
} from '../../contracts/runs.js';
import { stateResultSchema } from '../../contracts/state.js';
import type { RunStore } from '../../ports/runs.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { createSqliteServiceStore } from './service-store.js';
import { runControl, saveRunControl, appendRunEvent } from './run-events.js';

function identifier(kind: string, value: unknown): string {
  return `${kind}-${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function createSqliteRunStore(db: StateDatabase, now: () => number): RunStore {
  const queue = createSqliteServiceStore(db);
  function job(jobId: string) {
    const result = queue.read(jobId);

    if (result.outcome === 'rejected') {
      stateFailure(result.error.code);
    }

    return result.value ?? stateFailure('state_not_found');
  }

  function cancellation(jobId: string, key?: string) {
    return key === undefined
      ? db.get(
          runCancellationSchema,
          'SELECT data FROM run_cancellations WHERE job_id=? ORDER BY rowid DESC LIMIT 1',
          jobId,
        )
      : db.get(
          runCancellationSchema,
          'SELECT data FROM run_cancellations WHERE job_id=? AND cancel_key=?',
          jobId,
          key,
        );
  }

  function view(jobId: string): RunView {
    const selected = job(jobId);
    const control = runControl(db, jobId);
    const report = control.reportId
      ? db.get(acceptedRunReportSchema, 'SELECT data FROM run_reports WHERE id=?', control.reportId)
      : null;
    const responses = db
      .statement('SELECT data FROM run_responses WHERE job_id=? ORDER BY rowid DESC LIMIT 10')
      .all(jobId)
      .map((row) => db.data(runResponseSchema, row) ?? stateFailure('state_invalid_data'));
    const resumes = db
      .statement('SELECT data FROM run_resumes WHERE job_id=? ORDER BY rowid DESC LIMIT 10')
      .all(jobId)
      .map((row) => db.data(runResumeSchema, row) ?? stateFailure('state_invalid_data'));
    const resourceRows = db
      .statement(
        'SELECT id,kind,released_at FROM resources WHERE attempt_id=? ORDER BY id LIMIT 100',
      )
      .all(selected.attempt.id);
    const resourceCount = Number(
      db
        .statement('SELECT COUNT(*) AS count FROM resources WHERE attempt_id=?')
        .get(selected.attempt.id)?.count ?? 0,
    );
    const uncertain = resumes.some((resume) => ['pending', 'unknown'].includes(resume.state));
    const task = selected.job.intent.task;
    const workflow =
      task && typeof task === 'object' && !Array.isArray(task) && typeof task.workflow === 'string'
        ? task.workflow
        : '';
    const progress = implementationProgressSchema.safeParse(
      selected.entry.observation?.evidence[workflow],
    );
    const workflowBlocker =
      progress.success && ['needs_decision', 'blocked', 'failed'].includes(progress.data.state)
        ? (progress.data.state as 'needs_decision' | 'blocked' | 'failed')
        : null;
    const status =
      control.phase !== 'active'
        ? control.phase
        : uncertain || selected.entry.state === 'unknown'
          ? 'unknown'
          : (workflowBlocker ??
            (selected.entry.state === 'dispatching' ? 'starting' : selected.entry.state));

    return runViewSchema.parse({
      status,
      job: selected,
      control,
      report,
      responses,
      resumes,
      cancellation: cancellation(jobId),
      cleanup: {
        state: 'retained',
        checkoutId: selected.job.checkoutId,
        resourceCount,
        resources: resourceRows.map((row) => ({
          id: row.id,
          kind: row.kind,
          releasedAt: row.released_at,
        })),
      },
    });
  }

  function scope(input: RunEventScope) {
    if (
      input.projectId &&
      !db.statement('SELECT id FROM projects WHERE id=?').get(input.projectId)
    ) {
      stateFailure('project_not_found');
    }

    if (input.jobId) {
      const selected = job(input.jobId);

      if (input.projectId && input.projectId !== selected.job.projectId) {
        stateFailure('state_conflict');
      }
    }
  }

  function cursor(input: RunEventScope & { consumer: string }): RunCursor {
    scope(input);
    const filter = {
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    };

    return (
      db.get(
        runCursorSchema,
        'SELECT data FROM run_cursors WHERE consumer=? AND scope=?',
        input.consumer,
        canonicalJson(filter),
      ) ?? { schemaVersion: 1, consumer: input.consumer, ...filter, after: 0 }
    );
  }

  return {
    inspect: (id) =>
      db.read(() => {
        const result = queue.read(id);

        if (result.outcome === 'rejected') {
          stateFailure(result.error.code);
        }

        return result.value ? view(id) : null;
      }),
    report: (id, key) =>
      db.read(() =>
        db.get(
          acceptedRunReportSchema,
          'SELECT data FROM run_reports WHERE job_id=? AND report_key=?',
          id,
          key,
        ),
      ),
    acceptReport({ report: candidate, expectedRevision }) {
      return db.write(() => {
        const report = acceptedRunReportSchema.parse(candidate);
        const selected = job(report.jobId);
        const existing = db.get(
          acceptedRunReportSchema,
          'SELECT data FROM run_reports WHERE job_id=? AND report_key=?',
          report.jobId,
          report.key,
        );

        if (existing) {
          if (canonicalJson(existing.request) !== canonicalJson(report.request)) {
            stateFailure('state_conflict');
          }

          return { value: view(report.jobId), disposition: 'existing' };
        }

        const control = runControl(db, report.jobId);

        if (
          control.revision !== expectedRevision ||
          control.phase !== 'active' ||
          report.attemptId !== selected.attempt.id ||
          selected.effect.state !== 'confirmed'
        ) {
          stateFailure('state_conflict');
        }

        if (
          db
            .statement(
              "SELECT 1 FROM run_resumes WHERE job_id=? AND state IN ('authorized','pending','unknown')",
            )
            .get(report.jobId)
        ) {
          stateFailure('state_reconciliation_required');
        }

        const outcome = report.request.proposal.outcome;
        const phase =
          outcome === 'needs_decision'
            ? 'needs_decision'
            : outcome === 'failed'
              ? 'failed'
              : 'completed';
        db.statement('INSERT INTO run_reports(job_id,report_key,id,data) VALUES (?,?,?,?)').run(
          report.jobId,
          report.key,
          report.id,
          canonicalJson(report),
        );
        saveRunControl(db, report.jobId, {
          phase,
          revision: control.revision + 1,
          reportId: report.id,
        });

        if (phase !== 'needs_decision') {
          const result = stateResultSchema.parse({
            id: identifier('result', report.id),
            attemptId: selected.attempt.id,
            outcome: phase,
            createdAt: report.validatedAt,
            evidence: {
              reportId: report.id,
              commit: report.evidence.commit,
              acceptance: 'local-host',
            },
          });
          db.statement('INSERT INTO results(id,attempt_id,data) VALUES (?,?,?)').run(
            result.id,
            result.attemptId,
            canonicalJson(result),
          );
          db.statement('UPDATE attempts SET resolved_at=? WHERE id=?').run(
            result.createdAt,
            result.attemptId,
          );
        }

        appendRunEvent(db, selected, 'report_accepted', now(), {
          reportId: report.id,
          key: report.key,
          outcome: phase,
        });

        return { value: view(report.jobId), disposition: 'created' };
      });
    },
    readResponse: (jobId, id) =>
      db.read(() =>
        db.get(
          runResponseSchema,
          'SELECT data FROM run_responses WHERE job_id=? AND id=?',
          jobId,
          id,
        ),
      ),
    response(input) {
      return db.write(() => {
        const selected = job(input.jobId);
        const existing = db.get(
          runResponseSchema,
          'SELECT data FROM run_responses WHERE job_id=? AND response_key=?',
          input.jobId,
          input.key,
        );

        if (existing) {
          if (existing.text !== input.text || existing.decisionId !== input.decisionId) {
            stateFailure('state_conflict');
          }

          return { value: view(input.jobId), disposition: 'existing' };
        }

        const control = runControl(db, input.jobId);

        if (control.phase !== 'needs_decision' || control.reportId !== input.decisionId) {
          stateFailure('state_conflict');
        }

        const response = runResponseSchema.parse({
          ...input,
          id: identifier('response', input),
          attemptId: selected.attempt.id,
          createdAt: now(),
        });
        db.statement('INSERT INTO run_responses(job_id,response_key,id,data) VALUES (?,?,?,?)').run(
          input.jobId,
          input.key,
          response.id,
          canonicalJson(response),
        );
        appendRunEvent(db, selected, 'response_recorded', now(), {
          responseId: response.id,
          key: input.key,
          decisionId: input.decisionId,
        });

        return { value: view(input.jobId), disposition: 'created' };
      });
    },
    resume: (id, key) =>
      db.read(() =>
        db.get(
          runResumeSchema,
          'SELECT data FROM run_resumes WHERE job_id=? AND resume_key=?',
          id,
          key,
        ),
      ),
    beginResume(input) {
      return db.write(() => {
        const selected = job(input.jobId);
        const existing = db.get(
          runResumeSchema,
          'SELECT data FROM run_resumes WHERE job_id=? AND resume_key=?',
          input.jobId,
          input.key,
        );

        if (existing) {
          if (existing.responseId !== input.responseId) {
            stateFailure('state_conflict');
          }

          return { value: { run: view(input.jobId), resume: existing }, disposition: 'existing' };
        }

        const control = runControl(db, input.jobId);
        const response = db.get(
          runResponseSchema,
          'SELECT data FROM run_responses WHERE id=? AND job_id=?',
          input.responseId,
          input.jobId,
        );

        if (
          control.phase !== 'needs_decision' ||
          !response ||
          response.attemptId !== selected.attempt.id ||
          response.decisionId !== control.reportId ||
          selected.entry.observation?.state !== 'running'
        ) {
          stateFailure('state_conflict');
        }

        const id = identifier('resume', input);
        const resume = runResumeSchema.parse({
          ...input,
          id,
          attemptId: selected.attempt.id,
          actionKey: id,
          state: 'authorized',
          reason: null,
          createdAt: now(),
        });
        db.statement(
          'INSERT INTO run_resumes(job_id,resume_key,response_id,state,data) VALUES (?,?,?,?,?)',
        ).run(input.jobId, input.key, input.responseId, resume.state, canonicalJson(resume));
        saveRunControl(db, input.jobId, {
          ...control,
          phase: 'active',
          revision: control.revision + 1,
        });
        appendRunEvent(db, selected, 'resume_authorized', now(), {
          resumeId: id,
          responseId: input.responseId,
          key: input.key,
        });

        return { value: { run: view(input.jobId), resume }, disposition: 'created' };
      });
    },
    transitionResume(input) {
      return db.write(() => {
        const selected = job(input.jobId);
        const saved =
          db.get(
            runResumeSchema,
            'SELECT data FROM run_resumes WHERE job_id=? AND resume_key=?',
            input.jobId,
            input.key,
          ) ?? stateFailure('state_not_found');
        const control = runControl(db, input.jobId);

        if (saved.state === input.state && saved.reason === input.reason) {
          return { value: view(input.jobId), disposition: 'existing' };
        }

        if (
          saved.state !== input.expected ||
          (input.state === 'pending' && control.phase !== 'active')
        ) {
          stateFailure('state_conflict');
        }

        if (
          !(
            (saved.state === 'authorized' && ['pending', 'blocked'].includes(input.state)) ||
            (['pending', 'unknown'].includes(saved.state) &&
              ['acknowledged', 'unknown', 'blocked'].includes(input.state))
          )
        ) {
          stateFailure('state_conflict');
        }

        const resume = runResumeSchema.parse({
          ...saved,
          state: input.state,
          reason: input.reason,
        });
        db.statement('UPDATE run_resumes SET state=?,data=? WHERE job_id=? AND resume_key=?').run(
          resume.state,
          canonicalJson(resume),
          input.jobId,
          input.key,
        );

        if (resume.state === 'blocked' && control.phase === 'active') {
          saveRunControl(db, input.jobId, {
            ...control,
            phase: 'needs_decision',
            revision: control.revision + 1,
          });
        }

        appendRunEvent(db, selected, 'resume_observed', now(), {
          resumeId: resume.id,
          state: resume.state,
          reason: resume.reason,
        });

        return { value: view(input.jobId), disposition: 'updated' };
      });
    },
    cancellation: (id, key) => db.read(() => cancellation(id, key)),
    cancel(input) {
      return db.write(() => {
        const selected = job(input.jobId);
        const existing = cancellation(input.jobId, input.key);

        if (existing) {
          if (existing.interrupt !== input.interrupt) {
            stateFailure('state_conflict');
          }

          return { value: view(input.jobId), disposition: 'existing' };
        }

        const control = runControl(db, input.jobId);
        const stopped =
          selected.entry.claim === null ||
          selected.entry.observation?.state === 'quiescent' ||
          selected.entry.observation?.state === 'not_started';
        const requestedCancellation = runCancellationSchema.parse({
          ...input,
          attemptId: selected.attempt.id,
          createdAt: now(),
          interruptState: !input.interrupt ? 'not_requested' : stopped ? 'not_needed' : 'requested',
        });
        db.statement('INSERT INTO run_cancellations(job_id,cancel_key,data) VALUES (?,?,?)').run(
          input.jobId,
          input.key,
          canonicalJson(requestedCancellation),
        );

        if (!['completed', 'failed', 'cancelled'].includes(control.phase)) {
          saveRunControl(db, input.jobId, {
            ...control,
            phase: stopped ? 'cancelled' : 'cancel_requested',
            revision: control.revision + 1,
          });
        }

        appendRunEvent(db, selected, stopped ? 'cancelled' : 'cancel_requested', now(), {
          key: input.key,
          interrupt: input.interrupt,
        });

        return { value: view(input.jobId), disposition: 'created' };
      });
    },
    observeCancellation(input) {
      return db.write(() => {
        const selected = job(input.jobId);
        const saved = cancellation(input.jobId, input.key) ?? stateFailure('state_not_found');

        if (
          !['requested', 'unknown'].includes(saved.interruptState) ||
          (saved.interruptState === 'unknown' && input.state !== 'acknowledged') ||
          !['acknowledged', 'blocked', 'unknown'].includes(input.state)
        ) {
          return { value: view(input.jobId), disposition: 'existing' };
        }

        db.statement('UPDATE run_cancellations SET data=? WHERE job_id=? AND cancel_key=?').run(
          canonicalJson({ ...saved, interruptState: input.state }),
          input.jobId,
          input.key,
        );
        appendRunEvent(db, selected, 'cancel_observed', now(), {
          key: input.key,
          state: input.state,
        });

        return { value: view(input.jobId), disposition: 'updated' };
      });
    },
    events(input) {
      return db.read(() => {
        scope(input);
        const highWatermark = Number(
          db.statement('SELECT COALESCE(MAX(id),0) AS id FROM run_events').get()?.id ?? 0,
        );

        if (input.after > highWatermark) {
          stateFailure('state_conflict');
        }

        const rows = db
          .statement(
            'SELECT id,data FROM run_events WHERE id>? AND id<=? AND (? IS NULL OR project_id=?) AND (? IS NULL OR job_id=?) ORDER BY id LIMIT ?',
          )
          .all(
            input.after,
            highWatermark,
            input.projectId ?? null,
            input.projectId ?? null,
            input.jobId ?? null,
            input.jobId ?? null,
            input.limit + 1,
          );
        const events = rows
          .slice(0, input.limit)
          .map((row) =>
            runEventSchema.parse({ ...JSON.parse(String(row.data)), id: Number(row.id) }),
          );

        return {
          events,
          nextCursor:
            rows.length > input.limit ? (events.at(-1)?.id ?? input.after) : highWatermark,
          highWatermark,
        };
      });
    },
    cursor: (input) => db.read(() => cursor(input)),
    checkpoint(input) {
      return db.write(() => {
        const saved = cursor(input);
        const high = Number(
          db.statement('SELECT COALESCE(MAX(id),0) AS id FROM run_events').get()?.id ?? 0,
        );

        if (input.after > high || input.after < input.expected || input.after < saved.after) {
          stateFailure('state_conflict');
        }

        if (saved.after === input.after) {
          return { value: saved, disposition: 'existing' };
        }

        if (saved.after !== input.expected) {
          stateFailure('state_conflict');
        }

        const updated = runCursorSchema.parse({ ...saved, after: input.after });
        const { schemaVersion: _version, consumer: _consumer, after: _after, ...filter } = saved;
        db.statement(
          'INSERT INTO run_cursors(consumer,scope,data) VALUES (?,?,?) ON CONFLICT(consumer,scope) DO UPDATE SET data=excluded.data',
        ).run(saved.consumer, canonicalJson(filter), canonicalJson(updated));

        return { value: updated, disposition: 'updated' };
      });
    },
  };
}
