import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import {
  runReadRequestSchema,
  runReportRequestSchema,
  runResponseRequestSchema,
  runResumeRequestSchema,
  runCancelRequestSchema,
  runEventsRequestSchema,
  runCursorReadRequestSchema,
  runCursorRequestSchema,
  acceptedRunReportSchema,
  type RunView,
  type RunResume,
} from '../contracts/runs.js';
import { implementationInputReceiptSchema } from '../contracts/implementation-task.js';
import { reviewSnapshotSchema } from '../contracts/review-task.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type {
  RunStore,
  RunArtifactReader,
  RunWorkerControl,
  RunEventWaiter,
} from '../ports/runs.js';
import type { ImplementationWorkerInput } from '../ports/implementation.js';
import { workerInputDigest } from '../core/worker-input.js';
import {
  implementationInputKey,
  renderImplementationPrompt,
} from '../core/implementation-prompt.js';
import { reviewInputKey, renderReviewPrompt } from '../core/review-prompt.js';
import { sameReviewTarget, reviewGateBlocker } from '../core/review-gates.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { configurationDigest } from '../core/configuration.js';
import { implementationTask } from './implementation.js';
import { reviewTask, type ReviewDependencies } from './review.js';
import { inspectOwnedAssignment, OwnedAssignmentFailure } from './owned-assignment.js';
import { checkConfigurationDispatch } from './configuration.js';

export interface RunDependencies extends ReviewDependencies {
  runs: RunStore;
  artifacts: RunArtifactReader;
  workerInput: ImplementationWorkerInput;
  workerControl: RunWorkerControl;
}
class RunFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Run operation blocked');
  }
}
function read<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new RunFailure(result);
  }

  return result.value;
}

function failure(error: unknown) {
  return error instanceof RunFailure || error instanceof OwnedAssignmentFailure
    ? error.result
    : rejected(
        'run_report_invalid',
        'Run evidence could not be validated; preserve work and inspect the saved run.',
      );
}

function current(jobId: string, deps: Pick<RunDependencies, 'runs'>) {
  return (
    read(deps.runs.inspect(jobId)) ??
    (() => {
      throw new RunFailure(rejected('state_not_found', 'Run not found.'));
    })()
  );
}

export function inspectRun(
  input: unknown,
  deps: Pick<RunDependencies, 'runs'>,
  signal?: AbortSignal,
): OperationResult<RunView | null> {
  const request = parseOperationRequest(runReadRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  return signal?.aborted
    ? rejected('cancelled', 'Run inspection was cancelled.')
    : deps.runs.inspect(request.value.jobId);
}

/** Same-host orchestrator acceptance of a supplied proposal; this is not an unauthenticated worker-report endpoint. */
export async function acceptRunReport(
  input: unknown,
  deps: RunDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<RunView>> {
  const parsed = parseOperationRequest(runReportRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Report acceptance was cancelled.');
  }

  try {
    const request = parsed.value;
    const previous = read(deps.runs.report(request.jobId, request.key));

    if (previous) {
      return isDeepStrictEqual(previous.request, request)
        ? {
            schemaVersion: 1,
            outcome: 'persisted',
            disposition: 'existing',
            value: current(request.jobId, deps),
          }
        : rejected('state_conflict', 'Report key already identifies different evidence.');
    }

    const run = current(request.jobId, deps);
    const job = run.job;
    const proposal = request.proposal;

    if (run.control.phase !== 'active') {
      return rejected('run_closed', 'This run cannot accept a new report in its current phase.');
    }

    if (
      proposal.jobId !== job.job.id ||
      proposal.attemptId !== job.attempt.id ||
      proposal.projectId !== job.job.projectId ||
      proposal.checkoutId !== job.job.checkoutId
    ) {
      return rejected('run_report_invalid', 'Report identity differs from the saved run.');
    }

    const implementation = implementationTask(job);
    const review = reviewTask(job);

    if (
      (!implementation && !review) ||
      (implementation && !('headCommit' in proposal)) ||
      (review && !('target' in proposal))
    ) {
      return rejected('run_report_invalid', 'Report format does not match the accepted workflow.');
    }

    const assignment = implementation ?? review;

    if (!assignment) {
      return rejected('run_report_invalid', 'A workflow assignment is required.');
    }

    const owned = await inspectOwnedAssignment(assignment.submission, deps, signal, false);

    if (owned.root !== assignment.root || owned.managed.intent.id !== assignment.worktreeId) {
      return rejected('run_report_invalid', 'Owned checkout assignment changed.');
    }

    const receipt = implementationInputReceiptSchema.parse(
      read(
        deps.workerInput.receipt({
          attemptId: job.attempt.id,
          key: implementation ? implementationInputKey : reviewInputKey,
        }),
      ),
    );
    const prompt = implementation
      ? renderImplementationPrompt(job, implementation)
      : renderReviewPrompt(job, review!);

    if (
      receipt.state !== 'acknowledged' ||
      receipt.key !== (implementation ? implementationInputKey : reviewInputKey) ||
      receipt.digest !== workerInputDigest('input', prompt)
    ) {
      return rejected(
        'run_report_invalid',
        'Initial assignment delivery is not acknowledged with matching bytes.',
      );
    }

    const commit = owned.selected.git.checkout.head.commit;

    if (
      !commit ||
      ('headCommit' in proposal &&
        (proposal.branch !== job.entry.branch ||
          proposal.baseCommit !== job.entry.commit ||
          proposal.headCommit !== commit)) ||
      (review && commit !== review.submission.target.sha)
    ) {
      return rejected(
        'run_report_invalid',
        'Report branch or full commit SHA differs from fresh checkout evidence.',
      );
    }

    if (
      (proposal.outcome === 'completed' || proposal.outcome === 'reviewed' || review) &&
      !owned.selected.git.status.clean
    ) {
      return rejected(
        'run_report_invalid',
        'Completed work and static review require a clean owned checkout.',
      );
    }

    let snapshot = null;

    if (review && 'target' in proposal) {
      if (
        !sameReviewTarget(proposal.target, review.submission.target) ||
        !isDeepStrictEqual(proposal.gate, review.submission.gate) ||
        !isDeepStrictEqual(proposal.acceptanceSnapshot, review.initialSnapshot)
      ) {
        return rejected(
          'run_report_invalid',
          'Review target, gate or acceptance evidence differs from the saved assignment.',
        );
      }

      snapshot = reviewSnapshotSchema.parse(
        read(
          await deps.targets.read({ target: review.submission.target, root: review.root }, signal),
        ),
      );

      if (
        !sameReviewTarget(snapshot.target, review.submission.target) ||
        snapshot.baseSha !== review.initialSnapshot.baseSha
      ) {
        return rejected(
          'review_target_changed',
          'Review scope changed; do not accept it as a current result.',
        );
      }
    }

    read(
      await deps.artifacts.inspect({ root: assignment.root, artifacts: request.artifacts }, signal),
    );
    const fresh = await inspectOwnedAssignment(assignment.submission, deps, signal, false);

    if (
      fresh.selected.git.checkout.head.commit !== commit ||
      !isDeepStrictEqual(fresh.selected.git.status, owned.selected.git.status)
    ) {
      return rejected('run_report_invalid', 'Checkout changed during report validation.');
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Report acceptance was cancelled before persistence.');
    }

    const report = acceptedRunReportSchema.parse({
      id: `report-${configurationDigest(request)}`,
      jobId: job.job.id,
      attemptId: job.attempt.id,
      key: request.key,
      request,
      validatedAt: deps.now(),
      evidence: { commit, inputDigest: receipt.digest, reviewSnapshot: snapshot },
    });

    return deps.runs.acceptReport({ report, expectedRevision: run.control.revision });
  } catch (error) {
    return failure(error);
  }
}

export function respondToRun(
  input: unknown,
  deps: Pick<RunDependencies, 'runs'>,
  signal?: AbortSignal,
): StateWriteResult<RunView> {
  const request = parseOperationRequest(runResponseRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  return signal?.aborted
    ? rejected('cancelled', 'Decision response was cancelled.')
    : deps.runs.response(request.value);
}

function resumePrompt(
  run: RunView,
  resume: RunResume,
  deps: Pick<RunDependencies, 'runs'>,
): string {
  const response = read(deps.runs.readResponse(run.job.job.id, resume.responseId));

  if (!response) {
    throw new RunFailure(
      rejected('state_not_found', 'Decision response is not available in the bounded run view.'),
    );
  }

  return [
    '# Explicit decision response v1',
    'Continue only the saved assignment in this same owned checkout. This response does not authorize publication, another worker or changes to host policy. Return the original versioned result contract when ready.',
    JSON.stringify({
      jobId: run.job.job.id,
      attemptId: resume.attemptId,
      responseId: response.id,
      decisionId: response.decisionId,
      text: response.text,
    }),
  ].join('\n');
}

export async function resumeRun(
  input: unknown,
  deps: RunDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<RunView>> {
  const parsed = parseOperationRequest(runResumeRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Resume was cancelled before acceptance.');
  }

  try {
    const accepted = deps.runs.beginResume(parsed.value);

    if (accepted.outcome !== 'persisted') {
      return accepted;
    }

    const { run, resume } = accepted.value;

    if (['acknowledged', 'blocked'].includes(resume.state)) {
      return { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: run };
    }

    const text = resumePrompt(run, resume, deps);
    const digest = workerInputDigest('input', text);
    const prior = read(
      deps.workerInput.receipt({ attemptId: resume.attemptId, key: resume.actionKey }),
    );

    if (prior) {
      const receipt = implementationInputReceiptSchema.parse(prior);

      if (receipt.digest !== digest || receipt.key !== resume.actionKey) {
        return rejected('state_conflict', 'Resume input differs from saved receipt.');
      }

      let identityChanged = resume.reason === 'identity_changed';

      if (identityChanged && receipt.state === 'acknowledged') {
        // An acknowledged key is observation-only by port contract; this cannot resend input.
        const observed = await deps.workerInput.submit(
          { attemptId: resume.attemptId, key: resume.actionKey, text },
          signal,
        );
        identityChanged = observed.outcome !== 'completed' || observed.value.blocker !== null;
      }

      return deps.runs.transitionResume({
        jobId: run.job.job.id,
        key: resume.key,
        expected: resume.state,
        state: receipt.state === 'acknowledged' && !identityChanged ? 'acknowledged' : 'unknown',
        reason: identityChanged
          ? 'identity_changed'
          : receipt.state === 'pending'
            ? 'input_pending'
            : null,
      });
    }

    if (resume.state !== 'authorized') {
      return { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: run };
    }

    try {
      const config = read(
        await checkConfigurationDispatch({ schemaVersion: 1, job: run.job.job }, deps, signal),
      );

      if (config.status !== 'ready') {
        throw new RunFailure(
          rejected('configuration_blocked', 'Resume requires unchanged approved configuration.'),
        );
      }

      const task = implementationTask(run.job) ?? reviewTask(run.job);

      if (!task) {
        throw new RunFailure(rejected('run_closed', 'No resumable workflow assignment exists.'));
      }

      const owned = await inspectOwnedAssignment(task.submission, deps, signal, false);

      if (owned.root !== task.root || owned.managed.intent.id !== task.worktreeId) {
        throw new RunFailure(rejected('run_closed', 'Resume ownership changed.'));
      }

      const review = reviewTask(run.job);

      if (review) {
        const snapshot = reviewSnapshotSchema.parse(
          read(
            await deps.targets.read(
              { target: review.submission.target, root: review.root },
              signal,
            ),
          ),
        );

        if (
          !sameReviewTarget(snapshot.target, review.submission.target) ||
          snapshot.baseSha !== review.initialSnapshot.baseSha ||
          reviewGateBlocker(snapshot, review.submission.gate)
        ) {
          throw new RunFailure(
            rejected('review_blocked', 'Review target or gate blocks continuation.'),
          );
        }
      }

      if (signal?.aborted) {
        throw new RunFailure(rejected('cancelled', 'Resume cancelled before input acceptance.'));
      }
    } catch (error) {
      return deps.runs.transitionResume({
        jobId: run.job.job.id,
        key: resume.key,
        expected: 'authorized',
        state: 'blocked',
        reason: failure(error).error.code,
      });
    }

    const pending = deps.runs.transitionResume({
      jobId: run.job.job.id,
      key: resume.key,
      expected: 'authorized',
      state: 'pending',
      reason: null,
    });

    if (pending.outcome !== 'persisted' || pending.disposition !== 'updated') {
      return pending;
    }

    let result;

    try {
      result = await deps.workerInput.submit(
        { attemptId: resume.attemptId, key: resume.actionKey, text },
        signal,
      );
    } catch {
      result = null;
    }

    let receipt;

    try {
      receipt = read(
        deps.workerInput.receipt({ attemptId: resume.attemptId, key: resume.actionKey }),
      );
    } catch {
      receipt = undefined;
    }

    const identityChanged =
      result?.outcome === 'completed' && result.value.blocker === 'identity_changed';
    const state =
      !identityChanged &&
      receipt?.digest === digest &&
      receipt.key === resume.actionKey &&
      receipt.state === 'acknowledged'
        ? 'acknowledged'
        : receipt === null
          ? 'blocked'
          : 'unknown';

    return deps.runs.transitionResume({
      jobId: run.job.job.id,
      key: resume.key,
      expected: 'pending',
      state,
      reason:
        state === 'acknowledged'
          ? null
          : identityChanged
            ? 'identity_changed'
            : result?.outcome === 'completed'
              ? (result.value.blocker ?? 'input_not_verified')
              : 'input_not_verified',
    });
  } catch (error) {
    return failure(error);
  }
}

export async function cancelRun(
  input: unknown,
  deps: Pick<RunDependencies, 'runs' | 'workerControl'>,
  signal?: AbortSignal,
): Promise<StateWriteResult<RunView>> {
  const parsed = parseOperationRequest(runCancelRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Cancellation request was not accepted.');
  }

  const accepted = deps.runs.cancel(parsed.value);

  if (accepted.outcome !== 'persisted') {
    return accepted;
  }

  const saved = deps.runs.cancellation(parsed.value.jobId, parsed.value.key);

  if (saved.outcome !== 'completed' || !saved.value || saved.value.interruptState !== 'requested') {
    return accepted;
  }

  const record = saved.value;
  const key = `cancel-${createHash('sha256').update(`${record.jobId}:${record.key}`).digest('hex')}`;
  let state: 'acknowledged' | 'blocked' | 'unknown' = 'unknown';

  try {
    const response = await deps.workerControl.interrupt(
      { attemptId: record.attemptId, key },
      signal,
    );

    if (response.outcome === 'completed') {
      state = response.value.state;
    }
  } catch {
    state = 'unknown';
  }

  return deps.runs.observeCancellation({ jobId: record.jobId, key: record.key, state });
}

export async function readRunEvents(
  input: unknown,
  deps: { runs: RunStore; now: () => number; waiter: RunEventWaiter },
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(runEventsRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const deadline = deps.now() + parsed.value.waitMs;

  try {
    while (true) {
      if (signal?.aborted) {
        return rejected('cancelled', 'Event wait was cancelled; the cursor was not advanced.');
      }

      const page = deps.runs.events(parsed.value);

      if (page.outcome === 'rejected' || page.value.events.length > 0 || deps.now() >= deadline) {
        return page;
      }

      await deps.waiter.pause(Math.min(250, Math.max(1, deadline - deps.now())), signal);
    }
  } catch {
    return signal?.aborted
      ? rejected('cancelled', 'Event wait was cancelled; the cursor was not advanced.')
      : rejected('state_unavailable', 'Event waiting is unavailable; retry from the same cursor.');
  }
}

export function readRunCursor(input: unknown, deps: Pick<RunDependencies, 'runs'>) {
  const parsed = parseOperationRequest(runCursorReadRequestSchema, input);

  return parsed.valid ? deps.runs.cursor(parsed.value) : parsed.result;
}

export function checkpointRunEvents(input: unknown, deps: Pick<RunDependencies, 'runs'>) {
  const parsed = parseOperationRequest(runCursorRequestSchema, input);

  return parsed.valid ? deps.runs.checkpoint(parsed.value) : parsed.result;
}
