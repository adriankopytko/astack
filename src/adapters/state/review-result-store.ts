import { completePublicationAttempt } from './publication-completion.js';
import { githubPublicationReceiptSchema, githubPublicationSchema } from '../../contracts/github.js';
import { githubPublicationMarker } from '../../core/github-publication.js';
import { readAcceptedRunReport } from './run-report-codec.js';
import { isDeepStrictEqual } from 'node:util';
import {
  reviewResultObservationSchema,
  reviewResultPublicationSchema,
  reviewResultPublicationViewSchema,
  type ReviewResultRead,
  type ReviewResultPublication,
} from '../../contracts/review-results.js';
import {
  stateAttemptSchema,
  stateEffectIntentSchema,
  stateJobSchema,
} from '../../contracts/state.js';
import { acceptedReviewResult } from '../../core/review-result.js';
import { configurationDigest } from '../../core/configuration.js';
import type { ReviewResultStore } from '../../ports/review-results.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { acceptJobTransaction, createStateStore } from './store.js';
import { createSqliteServiceStore } from './service-store.js';
import { stateFailure } from './errors.js';
import { appendRunEvent } from './run-events.js';

export function createSqliteReviewResultStore(
  db: StateDatabase,
  now: () => number,
): ReviewResultStore {
  const state = createStateStore(db, now);
  const queue = createSqliteServiceStore(db, now);
  function source(input: ReviewResultRead, reportId: string) {
    const report = readAcceptedRunReport(
      db,
      'SELECT data FROM run_reports WHERE job_id=? AND report_key=?',
      input.jobId,
      input.reportKey,
    );
    const result = queue.read(input.jobId);

    if (
      !report ||
      report.id !== reportId ||
      result.outcome !== 'completed' ||
      !result.value ||
      !acceptedReviewResult(result.value, report)
    ) {
      return stateFailure('run_report_invalid');
    }

    return { report, job: result.value };
  }

  function view(record: ReviewResultPublication) {
    const effect = state.inspectRecord({ schemaVersion: 1, entity: 'effect', id: record.effectId });

    if (effect.outcome !== 'completed' || effect.value?.entity !== 'effect') {
      return stateFailure('state_invalid_data');
    }

    return reviewResultPublicationViewSchema.parse({ record, effect: effect.value.record });
  }

  return {
    observation(reportId) {
      return db.read(() =>
        db.get(
          reviewResultObservationSchema,
          'SELECT data FROM review_result_observations WHERE report_id=?',
          reportId,
        ),
      );
    },
    observe(input) {
      return db.write(() => {
        const selected = source(input.source, input.reportId);
        const old = db.get(
          reviewResultObservationSchema,
          'SELECT data FROM review_result_observations WHERE report_id=?',
          input.reportId,
        );

        if (
          (old?.revision ?? null) !== input.expectedRevision ||
          input.observation.reportId !== input.reportId ||
          (old && old.observedAt > input.observation.observedAt)
        ) {
          stateFailure('state_conflict');
        }

        const observation = reviewResultObservationSchema.parse({
          ...input.observation,
          revision: (old?.revision ?? -1) + 1,
        });
        db.statement(
          'INSERT INTO review_result_observations(report_id,data) VALUES (?,?) ON CONFLICT(report_id) DO UPDATE SET data=excluded.data',
        ).run(input.reportId, canonicalJson(observation));
        appendRunEvent(db, selected.job, 'review_result_observed', now(), {
          reportId: input.reportId,
          state: observation.state,
        });

        return { value: observation, disposition: 'updated' };
      });
    },
    find(input) {
      return db.read(() => {
        const record = db.get(
          reviewResultPublicationSchema,
          'SELECT data FROM review_result_publications WHERE job_id=? AND report_key=? AND request_key=?',
          input.jobId,
          input.reportKey,
          input.key,
        );

        return record ? view(record) : null;
      });
    },
    complete(input) {
      return db.write(() => {
        const record = db.get(
          reviewResultPublicationSchema,
          'SELECT data FROM review_result_publications WHERE job_id=? AND report_key=? AND request_key=?',
          input.jobId,
          input.reportKey,
          input.key,
        );

        if (!record) {
          return stateFailure('state_not_found');
        }

        const selected = source(record.request, record.request.reportId);
        const saved = view(record);
        const effect = saved.effect;
        const receipt = githubPublicationReceiptSchema.safeParse(effect.evidence?.receipt);
        const publication = githubPublicationSchema.safeParse(effect.intent.payload.publication);
        const marker = githubPublicationMarker({
          projectId: record.projectId,
          jobId: record.publicationJobId,
          attemptId: record.publicationAttemptId,
          effectId: record.effectId,
          key: 'review-result',
          publication: record.publication,
        });

        if (
          effect.state !== 'confirmed' ||
          effect.intent.kind !== 'github-publication:v1' ||
          effect.intent.attemptId !== record.publicationAttemptId ||
          effect.intent.key !== 'review-result' ||
          !publication.success ||
          !isDeepStrictEqual(publication.data, record.publication) ||
          !receipt.success ||
          receipt.data.kind !== record.publication.kind ||
          receipt.data.marker !== marker ||
          !isDeepStrictEqual(receipt.data.target, record.target) ||
          receipt.data.actor.toLowerCase() !== record.publication.actor.toLowerCase() ||
          configurationDigest(selected.report) !== record.reportDigest
        ) {
          return stateFailure('state_reconciliation_required');
        }

        const finalized = completePublicationAttempt(db, {
          jobId: record.publicationJobId,
          attemptId: record.publicationAttemptId,
          operation: 'review-result-publication',
          projectId: record.projectId,
          repositoryId: record.repositoryId,
          checkoutId: record.checkoutId,
          commit: record.target.sha,
          branch: record.branch,
          effectIds: [record.effectId],
          createdAt: receipt.data.observedAt,
          sourceJobId: record.request.jobId,
          sourceReportId: record.request.reportId,
        });

        if (finalized) {
          appendRunEvent(db, selected.job, 'publication_finalized', now(), {
            operation: 'review-result-publication',
            publicationId: record.id,
            attemptId: record.publicationAttemptId,
          });
        }

        return { value: saved, disposition: finalized ? 'updated' : 'existing' };
      });
    },
    reserve(input) {
      return db.write(() => {
        const record = reviewResultPublicationSchema.parse(input);
        const old = db.get(
          reviewResultPublicationSchema,
          'SELECT data FROM review_result_publications WHERE job_id=? AND report_key=? AND request_key=?',
          record.request.jobId,
          record.request.reportKey,
          record.request.key,
        );

        if (old) {
          if (!isDeepStrictEqual(old.request, record.request)) {
            stateFailure('state_conflict');
          }

          return { value: view(old), disposition: 'existing' };
        }

        const selected = source(record.request, record.request.reportId);
        const sourceResult = acceptedReviewResult(selected.job, selected.report)!;
        const report = selected.report;
        const job = selected.job;

        if (
          configurationDigest(report) !== record.reportDigest ||
          job.job.projectId !== record.projectId ||
          job.job.repositoryId !== record.repositoryId ||
          job.job.checkoutId !== record.checkoutId ||
          job.attempt.id !== record.sourceAttemptId ||
          !isDeepStrictEqual(record.publication.target, record.target) ||
          record.publication.kind === 'pull-request' ||
          record.target.sha !== report.evidence.commit ||
          !isDeepStrictEqual(record.target, sourceResult.assignment.submission.target) ||
          record.root !== sourceResult.assignment.root ||
          record.branch !== sourceResult.assignment.submission.branch
        ) {
          stateFailure('run_report_invalid');
        }

        const previous = db
          .statement('SELECT id FROM review_result_publications WHERE report_id=?')
          .get(report.id);

        if (previous) {
          stateFailure('state_reconciliation_required');
        }

        const publicationJob = stateJobSchema.parse({
          id: record.publicationJobId,
          projectId: record.projectId,
          repositoryId: record.repositoryId,
          checkoutId: record.checkoutId,
          requester: 'local-host',
          operation: 'review-result-publication',
          idempotencyKey: record.id,
          createdAt: record.createdAt,
          intent: { sourceJobId: record.request.jobId, sourceReportId: report.id },
        });
        acceptJobTransaction(db, publicationJob);
        const attempt = stateAttemptSchema.parse({
          id: record.publicationAttemptId,
          jobId: publicationJob.id,
          number: 1,
          branch: record.branch,
          commit: record.target.sha,
          createdAt: record.createdAt,
        });
        db.statement('INSERT INTO attempts(id,job_id,number,data) VALUES (?,?,?,?)').run(
          attempt.id,
          publicationJob.id,
          1,
          canonicalJson(attempt),
        );
        const effect = stateEffectIntentSchema.parse({
          id: record.effectId,
          attemptId: attempt.id,
          key: 'review-result',
          kind: 'github-publication:v1',
          createdAt: record.createdAt,
          payload: { publication: record.publication },
        });
        db.statement(
          "INSERT INTO effects(id,attempt_id,kind,effect_key,state,data) VALUES (?,?,?,?,'pending',?)",
        ).run(effect.id, attempt.id, effect.kind, effect.key, canonicalJson(effect));
        db.statement(
          'INSERT INTO review_result_publications(id,job_id,report_key,report_id,request_key,data) VALUES (?,?,?,?,?,?)',
        ).run(
          record.id,
          record.request.jobId,
          record.request.reportKey,
          report.id,
          record.request.key,
          canonicalJson(record),
        );
        appendRunEvent(db, job, 'review_publication_prepared', record.createdAt, {
          reportId: report.id,
          publicationId: record.id,
        });

        return { value: view(record), disposition: 'created' };
      });
    },
  };
}
