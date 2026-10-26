import { completePublicationAttempt } from './publication-completion.js';
import { isDeepStrictEqual } from 'node:util';
import {
  handoffRecordSchema,
  handoffViewSchema,
  pushReceiptSchema,
  type HandoffRecord,
  type HandoffView,
} from '../../contracts/handoff.js';
import {
  stateAttemptSchema,
  stateEffectIntentSchema,
  stateJobSchema,
} from '../../contracts/state.js';
import type { HandoffStore } from '../../ports/handoff.js';
import { githubPublicationMarker } from '../../core/github-publication.js';
import { configurationDigest } from '../../core/configuration.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { acceptJobTransaction, createStateStore } from './store.js';
import { createSqliteRunStore } from './run-store.js';
import { appendRunEvent } from './run-events.js';

export function createSqliteHandoffStore(db: StateDatabase, now: () => number): HandoffStore {
  const state = createStateStore(db, now);
  const runs = createSqliteRunStore(db, now);
  function effect(id: string) {
    const result = state.inspectRecord({ schemaVersion: 1, entity: 'effect', id });

    if (result.outcome !== 'completed' || result.value?.entity !== 'effect') {
      return stateFailure(result.outcome === 'rejected' ? result.error.code : 'state_invalid_data');
    }

    return result.value.record;
  }

  function source(record: HandoffRecord) {
    const result = runs.inspect(record.request.jobId);

    if (result.outcome !== 'completed' || !result.value) {
      return stateFailure(result.outcome === 'rejected' ? result.error.code : 'run_not_found');
    }

    const run = result.value;

    if (
      run.control.phase !== 'completed' ||
      run.report?.id !== record.request.reportId ||
      run.report.attemptId !== record.source.attemptId ||
      run.job.attempt.id !== record.source.attemptId ||
      run.report.evidence.commit !== record.source.headCommit ||
      run.job.job.projectId !== record.source.projectId ||
      run.job.job.repositoryId !== record.source.repositoryId ||
      run.job.job.checkoutId !== record.source.checkoutId
    ) {
      return stateFailure('handoff_blocked');
    }

    return run;
  }

  function view(record: HandoffRecord): HandoffView {
    return handoffViewSchema.parse({
      record,
      push: effect(record.pushEffectId),
      publication: effect(record.publicationEffectId),
    });
  }

  function save(record: HandoffRecord) {
    const parsed = handoffRecordSchema.parse(record);
    db.statement('UPDATE implementation_handoffs SET phase=?,data=? WHERE id=?').run(
      parsed.phase,
      canonicalJson(parsed),
      parsed.id,
    );
  }

  return {
    find(jobId, key) {
      return db.read(() => {
        const record =
          key === undefined
            ? db.get(
                handoffRecordSchema,
                'SELECT data FROM implementation_handoffs WHERE job_id=? ORDER BY rowid DESC LIMIT 1',
                jobId,
              )
            : db.get(
                handoffRecordSchema,
                'SELECT data FROM implementation_handoffs WHERE job_id=? AND request_key=?',
                jobId,
                key,
              );

        return record ? view(record) : null;
      });
    },
    reserve(input) {
      return db.write(() => {
        const record = handoffRecordSchema.parse(input);
        const old = db.get(
          handoffRecordSchema,
          'SELECT data FROM implementation_handoffs WHERE job_id=? AND request_key=?',
          record.request.jobId,
          record.request.key,
        );

        if (old) {
          if (!isDeepStrictEqual(old.request, record.request)) {
            stateFailure('state_conflict');
          }

          return { value: view(old), disposition: 'existing' };
        }

        if (
          record.phase !== 'prepared' ||
          record.receipt !== null ||
          record.followUpReview !== null
        ) {
          stateFailure('state_invalid_data');
        }

        const run = source(record);
        const current = db.get(
          handoffRecordSchema,
          "SELECT data FROM implementation_handoffs WHERE job_id=? AND phase!='abandoned'",
          record.request.jobId,
        );

        if (current) {
          if (record.request.replaces !== current.id || current.phase !== 'prepared') {
            stateFailure('state_conflict');
          }

          const prior = view(current);

          if (
            prior.push.state === 'unknown' ||
            (prior.push.state === 'pending' && prior.push.claim) ||
            prior.publication.state === 'confirmed' ||
            prior.publication.state === 'unknown' ||
            (prior.publication.state === 'pending' && prior.publication.claim)
          ) {
            stateFailure('state_reconciliation_required');
          }

          for (const entry of [prior.push, prior.publication]) {
            if (entry.state === 'pending') {
              const time = now();
              db.statement(
                "UPDATE effects SET state='cancelled',claim_owner=?,claim_token=?,claimed_at=?,expires_at=?,evidence=? WHERE id=? AND state='pending' AND claim_token IS NULL",
              ).run(
                current.id,
                current.id,
                time,
                time + 30000,
                canonicalJson({ kind: 'handoff-abandoned', notSent: true }),
                entry.intent.id,
              );
            }
          }

          save({ ...current, phase: 'abandoned' });
          appendRunEvent(db, run.job, 'handoff_abandoned', now(), { handoffId: current.id });
        } else if (record.request.replaces !== null) {
          stateFailure('state_conflict');
        }

        const job = stateJobSchema.parse({
          id: record.publicationJobId,
          projectId: record.source.projectId,
          repositoryId: record.source.repositoryId,
          checkoutId: record.source.checkoutId,
          requester: 'local-host',
          operation: 'implementation-handoff',
          idempotencyKey: record.id,
          createdAt: record.createdAt,
          intent: {
            handoffId: record.id,
            sourceJobId: record.request.jobId,
            sourceReportId: record.request.reportId,
          },
        });
        acceptJobTransaction(db, job);
        const attempt = stateAttemptSchema.parse({
          id: record.publicationAttemptId,
          jobId: job.id,
          number: 1,
          branch: record.source.branch,
          commit: record.source.headCommit,
          createdAt: record.createdAt,
        });
        db.statement('INSERT INTO attempts(id,job_id,number,data) VALUES (?,?,?,?)').run(
          attempt.id,
          job.id,
          1,
          canonicalJson(attempt),
        );

        const intents = [
          {
            id: record.pushEffectId,
            key: 'push',
            kind: 'git-push:v1',
            payload: {
              request: {
                repository: {
                  host: record.request.publication.target.host,
                  repository: record.request.publication.sourceRepository,
                },
                branch: record.request.publication.headBranch,
                sha: record.source.headCommit,
                expectedHead: record.request.expectedRemoteHead,
              },
            },
          },
          {
            id: record.publicationEffectId,
            key: 'pull-request',
            kind: 'github-publication:v1',
            payload: { publication: record.request.publication },
          },
        ];

        for (const item of intents) {
          const intent = stateEffectIntentSchema.parse({
            ...item,
            attemptId: attempt.id,
            createdAt: record.createdAt,
          });
          db.statement(
            "INSERT INTO effects(id,attempt_id,kind,effect_key,state,data) VALUES (?,?,?,?,'pending',?)",
          ).run(intent.id, attempt.id, intent.kind, intent.key, canonicalJson(intent));
        }

        db.statement(
          'INSERT INTO implementation_handoffs(id,job_id,project_id,request_key,phase,data) VALUES (?,?,?,?,?,?)',
        ).run(
          record.id,
          record.request.jobId,
          record.source.projectId,
          record.request.key,
          record.phase,
          canonicalJson(record),
        );
        appendRunEvent(db, run.job, 'handoff_prepared', record.createdAt, {
          handoffId: record.id,
          reportId: record.request.reportId,
          commit: record.source.headCommit,
        });

        return { value: view(record), disposition: 'created' };
      });
    },
    accept(input) {
      return db.write(() => {
        const record =
          db.get(
            handoffRecordSchema,
            'SELECT data FROM implementation_handoffs WHERE id=?',
            input.id,
          ) ?? stateFailure('handoff_not_found');

        if (record.phase === 'accepted' && !isDeepStrictEqual(record.receipt, input.receipt)) {
          stateFailure('state_conflict');
        }

        if (record.phase !== 'prepared' && record.phase !== 'accepted') {
          stateFailure('state_conflict');
        }

        const run = source(record);
        const observed = view(record);
        const push = pushReceiptSchema.parse(observed.push.evidence?.receipt);
        const receipt = input.receipt;
        const p = record.request.publication;
        const marker = githubPublicationMarker({
          projectId: record.source.projectId,
          jobId: record.publicationJobId,
          attemptId: record.publicationAttemptId,
          effectId: record.publicationEffectId,
          key: 'pull-request',
          publication: p,
        });

        if (
          observed.push.state !== 'confirmed' ||
          observed.publication.state !== 'confirmed' ||
          !isDeepStrictEqual(observed.publication.evidence?.receipt, receipt) ||
          push.sha !== record.source.headCommit ||
          push.branch !== p.headBranch ||
          push.repository.host !== p.target.host ||
          push.repository.repository !== p.sourceRepository ||
          receipt.kind !== 'pull-request' ||
          receipt.marker !== marker ||
          receipt.target.sha !== record.source.headCommit ||
          receipt.target.host !== p.target.host ||
          receipt.target.repository !== p.target.repository ||
          receipt.actor.toLowerCase() !== p.actor.toLowerCase()
        ) {
          stateFailure('handoff_target_changed');
        }

        const finalized = completePublicationAttempt(db, {
          jobId: record.publicationJobId,
          attemptId: record.publicationAttemptId,
          operation: 'implementation-handoff',
          projectId: record.source.projectId,
          repositoryId: record.source.repositoryId,
          checkoutId: record.source.checkoutId,
          commit: record.source.headCommit,
          branch: record.source.branch,
          effectIds: [record.pushEffectId, record.publicationEffectId],
          createdAt: record.acceptedAt ?? input.acceptedAt,
          sourceJobId: record.request.jobId,
          sourceReportId: record.request.reportId,
        });

        if (finalized) {
          appendRunEvent(db, run.job, 'publication_finalized', now(), {
            operation: 'implementation-handoff',
            publicationId: record.id,
            attemptId: record.publicationAttemptId,
          });
        }

        if (record.phase === 'accepted') {
          return { value: observed, disposition: finalized ? 'updated' : 'existing' };
        }

        const review = record.request.review;
        const saved = handoffRecordSchema.parse({
          ...record,
          phase: 'accepted',
          receipt,
          acceptedAt: input.acceptedAt,
          followUpReview: review
            ? {
                id: `follow-up-${configurationDigest({ handoffId: record.id })}`,
                authorization: 'explicit-handoff',
                state: 'requested',
                sourceJobId: record.request.jobId,
                sourceReportId: record.request.reportId,
                target: receipt.target,
                gate: review.gate,
                instructionPaths: review.instructionPaths,
              }
            : null,
        });
        save(saved);
        appendRunEvent(db, run.job, 'handoff_accepted', input.acceptedAt, {
          handoffId: record.id,
          reportId: record.request.reportId,
          commit: record.source.headCommit,
          target: receipt.target,
          followUpReviewId: saved.followUpReview?.id ?? null,
        });

        return { value: view(saved), disposition: 'updated' };
      });
    },
    followUps(input) {
      return db.read(() => {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
          stateFailure('invalid_request');
        }

        const rows = db
          .statement(
            "SELECT data FROM implementation_handoffs WHERE project_id=? AND id>? AND phase='accepted' AND json_extract(data,'$.followUpReview') IS NOT NULL ORDER BY id LIMIT ?",
          )
          .all(input.projectId, input.after, input.limit + 1);
        const records = rows
          .slice(0, input.limit)
          .map((row) => db.data(handoffRecordSchema, row) ?? stateFailure('state_invalid_data'));

        return {
          items: records.flatMap((record) =>
            record.followUpReview ? [record.followUpReview] : [],
          ),
          nextCursor: rows.length > input.limit ? (records.at(-1)?.id ?? null) : null,
        };
      });
    },
  };
}
