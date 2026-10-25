import { isDeepStrictEqual } from 'node:util';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import {
  reviewResultReadSchema,
  reviewResultExecuteSchema,
  reviewResultReconcileSchema,
  reviewResultPublicationReadSchema,
  type ReviewResultView,
  type ReviewResultPublicationView,
  type ReviewResultPublication,
} from '../contracts/review-results.js';
import { githubPublicationSchema } from '../contracts/github.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { RunStore } from '../ports/runs.js';
import type { StateStore } from '../ports/state-store.js';
import type { ReviewResultStore } from '../ports/review-results.js';
import type { GithubProvider } from '../ports/github.js';
import { acceptedReviewResult, renderReviewResult } from '../core/review-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { configurationDigest } from '../core/configuration.js';
import { publishGithubEffect } from './github-publication.js';
import {
  inspectOwnedAssignment,
  OwnedAssignmentFailure,
  type OwnedAssignmentReaderDependencies,
} from './owned-assignment.js';

export interface ReviewResultDependencies extends OwnedAssignmentReaderDependencies {
  runs: RunStore;
  results: ReviewResultStore;
  state: StateStore;
  github: GithubProvider;
  now: () => number;
  nextId: () => string;
}
class ResultFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Review result unavailable');
  }
}
function take<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new ResultFailure(result);
  }

  return result.value;
}

function failure(error: unknown) {
  return error instanceof ResultFailure || error instanceof OwnedAssignmentFailure
    ? error.result
    : rejected(
        'review_blocked',
        'Review result evidence could not be verified; inspect saved intent before retrying.',
      );
}

export function inspectReviewResult(
  input: unknown,
  deps: Pick<ReviewResultDependencies, 'runs' | 'results'>,
): OperationResult<ReviewResultView> {
  const parsed = parseOperationRequest(reviewResultReadSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const run = take(deps.runs.inspect(parsed.value.jobId));
    const report = take(deps.runs.report(parsed.value.jobId, parsed.value.reportKey));
    const source = run && report ? acceptedReviewResult(run.job, report) : null;

    if (!report || !source) {
      return rejected(
        'run_report_invalid',
        'Select an accepted reviewed report belonging to this exact run and attempt.',
      );
    }

    const observation = take(deps.results.observation(report.id));

    return completed({
      report,
      assignment: source.assignment,
      observation,
      freshness: observation?.state ?? (report.evidence.historicalReview ? 'stale' : 'not_checked'),
      fixReference: {
        jobId: report.jobId,
        attemptId: report.attemptId,
        reportId: report.id,
        reportKey: report.key,
        reportDigest: configurationDigest(report),
        commit: report.evidence.commit,
      },
    });
  } catch (error) {
    return failure(error);
  }
}

/** A saved observation is historical; this operation rechecks the exact remote scope explicitly. */
export async function observeReviewResult(
  input: unknown,
  deps: ReviewResultDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(reviewResultReadSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const view = take(inspectReviewResult(parsed.value, deps));
    const target = view.assignment.submission.target;
    const owned = await inspectOwnedAssignment(view.assignment.submission, deps, signal, false);

    if (
      owned.root !== view.assignment.root ||
      owned.managed.intent.id !== view.assignment.worktreeId
    ) {
      return rejected('review_blocked', 'Review result checkout identity changed.');
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Observation cancelled.');
    }

    const observed = await deps.github.inspectPullRequest({ target, root: owned.root }, signal);
    let state: 'current' | 'stale' | 'unavailable' = 'unavailable';
    let reason: string | null = observed.outcome === 'rejected' ? observed.error.code : null;

    if (observed.outcome === 'completed') {
      const current = observed.value;

      if (
        current.target.host !== target.host ||
        current.target.repository !== target.repository ||
        current.target.number !== target.number
      ) {
        return rejected('github_invalid_output', 'Provider returned a different PR.');
      }

      state =
        !isDeepStrictEqual(current.target, target) ||
        current.baseSha !== view.assignment.initialSnapshot.baseSha ||
        current.state !== 'OPEN' ||
        current.draft
          ? 'stale'
          : 'current';
      reason = state === 'stale' ? 'review_scope_changed' : null;
    } else if (observed.error.code === 'review_target_changed') {
      state = 'stale';
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Observation cancelled before persistence.');
    }

    return deps.results.observe({
      source: parsed.value,
      reportId: view.report.id,
      expectedRevision: view.observation?.revision ?? null,
      observation: { reportId: view.report.id, state, reason, observedAt: deps.now() },
    });
  } catch (error) {
    return failure(error);
  }
}

export function inspectReviewPublication(
  input: unknown,
  deps: Pick<ReviewResultDependencies, 'results'>,
) {
  const parsed = parseOperationRequest(reviewResultPublicationReadSchema, input);

  return parsed.valid ? deps.results.find(parsed.value) : parsed.result;
}

async function execute(
  record: ReviewResultPublication,
  mode: 'publish' | 'reconcile',
  deps: ReviewResultDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<ReviewResultPublicationView>> {
  const result = await publishGithubEffect(
    {
      schemaVersion: 1,
      effectId: record.effectId,
      root: record.root,
      mode,
      originalWriterStopped: mode === 'reconcile',
    },
    { store: deps.state, provider: deps.github, nextId: deps.nextId },
    signal,
  );

  if (result.outcome !== 'persisted') {
    return result;
  }

  const view = take(deps.results.find(record.request));

  if (!view) {
    return rejected('state_invalid_data', 'Publication intent disappeared.');
  }

  return { ...result, value: view };
}

export async function publishReviewResult(
  input: unknown,
  deps: ReviewResultDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<ReviewResultPublicationView>> {
  const parsed = parseOperationRequest(reviewResultExecuteSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const request = parsed.value.request;

  try {
    let previous = take(deps.results.find(request));

    if (previous && !isDeepStrictEqual(previous.record.request, request)) {
      return rejected('state_conflict', 'Publication key already identifies different content.');
    }

    if (previous?.effect.state === 'confirmed') {
      return await execute(previous.record, 'publish', deps, signal);
    }

    if (previous && (previous.effect.claim || previous.effect.state !== 'pending')) {
      return rejected(
        'state_reconciliation_required',
        'This publication cannot be resent; inspect or reconcile its original effect.',
      );
    }

    const source = take(
      inspectReviewResult(
        { schemaVersion: 1, jobId: request.jobId, reportKey: request.reportKey },
        deps,
      ),
    );

    if (source.report.id !== request.reportId) {
      return rejected('run_report_invalid', 'Select the exact accepted report ID.');
    }

    const proposal = source.report.request.proposal;

    if (
      !('findings' in proposal) ||
      request.findingIndexes?.some((index) => !proposal.findings[index])
    ) {
      return rejected(
        'invalid_request',
        'Select existing zero-based finding indexes from this accepted report.',
      );
    }

    const publication = githubPublicationSchema.safeParse({
      schemaVersion: 1,
      kind: request.kind,
      target: source.assignment.submission.target,
      actor: request.actor,
      body: renderReviewResult(source.report, request),
      ...(request.kind === 'review' ? { event: request.event } : {}),
    });

    if (!publication.success) {
      return rejected(
        'invalid_request',
        'Selected findings exceed publication limits or contain reserved marker content; select fewer finding indexes.',
      );
    }

    const observation = await observeReviewResult(
      { schemaVersion: 1, jobId: request.jobId, reportKey: request.reportKey },
      deps,
      signal,
    );

    if (observation.outcome !== 'persisted') {
      return observation;
    }

    if (observation.value.state !== 'current') {
      return rejected(
        'review_target_changed',
        'Only freshly current reviewed scope can be newly published. Historical findings are retained.',
      );
    }

    if (previous && !isDeepStrictEqual(previous.record.publication, publication.data)) {
      return rejected('state_conflict', 'Saved publication bytes changed.');
    }

    if (!previous) {
      const run = take(deps.runs.inspect(request.jobId));

      if (!run) {
        return rejected('run_not_found', 'Review run not found.');
      }

      const reserved = deps.results.reserve({
        id: deps.nextId(),
        request,
        projectId: run.job.job.projectId,
        repositoryId: run.job.job.repositoryId,
        checkoutId: run.job.job.checkoutId,
        sourceAttemptId: run.job.attempt.id,
        reportDigest: configurationDigest(source.report),
        root: source.assignment.root,
        branch: source.assignment.submission.branch,
        target: source.assignment.submission.target,
        publicationJobId: deps.nextId(),
        publicationAttemptId: deps.nextId(),
        effectId: deps.nextId(),
        publication: publication.data,
        createdAt: deps.now(),
      });

      if (reserved.outcome !== 'persisted') {
        return reserved;
      }

      previous = reserved.value;
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Cancelled before publication claim; inspect saved intent.');
    }

    return await execute(previous.record, 'publish', deps, signal);
  } catch (error) {
    return failure(error);
  }
}

export async function reconcileReviewPublication(
  input: unknown,
  deps: ReviewResultDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<ReviewResultPublicationView>> {
  const parsed = parseOperationRequest(reviewResultReconcileSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const { writersStopped: _stopped, ...source } = parsed.value;
    const saved = take(deps.results.find(source));

    return saved
      ? await execute(saved.record, 'reconcile', deps, signal)
      : rejected('state_not_found', 'Publication intent not found.');
  } catch (error) {
    return failure(error);
  }
}
