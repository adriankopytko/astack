import { isDeepStrictEqual } from 'node:util';
import {
  reviewSubmitRequestSchema,
  reviewReadRequestSchema,
  reviewTaskSchema,
  reviewSnapshotSchema,
  type ReviewTask,
  type ReviewJob,
} from '../contracts/review.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { ServiceJob } from '../contracts/service.js';
import type { ServiceWorkerRuntime } from '../ports/service.js';
import type { ImplementationWorkerInput } from '../ports/implementation.js';
import type { ReviewTargetReader } from '../ports/review.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { reviewGateBlocker, sameReviewTarget } from '../core/review-gates.js';
import { renderReviewPrompt, reviewInputKey } from '../core/review-prompt.js';
import { configurationDigest } from '../core/configuration.js';
import { inspectOwnedAssignment, OwnedAssignmentFailure } from './owned-assignment.js';
import { submitServiceJob } from './service.js';
import {
  createTaskDeliveryRuntime,
  taskDeliveryProgress,
  type TaskDeliveryDependencies,
} from './task-delivery.js';

export interface ReviewDependencies extends TaskDeliveryDependencies {
  targets: ReviewTargetReader;
}
class ReviewFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Review blocked');
  }
}
function read<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new ReviewFailure(result);
  }

  return result.value;
}

export function reviewTask(job: ServiceJob): ReviewTask | null {
  const parsed = reviewTaskSchema.safeParse(job.job.intent.task);

  if (!parsed.success) {
    return null;
  }

  const request = parsed.data.submission;

  return job.entry.role === 'reviewer' &&
    job.job.operation === 'delegate:reviewer' &&
    request.projectId === job.job.projectId &&
    request.checkoutId === job.job.checkoutId &&
    request.key === job.job.idempotencyKey &&
    request.branch === job.entry.branch &&
    request.commit === job.entry.commit
    ? parsed.data
    : null;
}

export function reviewView(job: ServiceJob): ReviewJob {
  const task = reviewTask(job);

  if (!task) {
    throw new ReviewFailure(
      rejected('invalid_request', 'The selected job is not a manual review assignment.'),
    );
  }

  return { job, review: taskDeliveryProgress(job, 'review'), assignment: task };
}

async function policy(
  task: ReviewTask,
  deps: ReviewDependencies,
  signal?: AbortSignal,
  job?: ServiceJob,
): Promise<string> {
  const value = hostConfigurationPolicySchema.safeParse(
    await deps.configuration.readPolicy(task.submission.projectId, signal),
  );

  if (
    !value.success ||
    value.data.projectId !== task.submission.projectId ||
    (job &&
      (value.data.repositoryId !== job.job.repositoryId ||
        configurationDigest(value.data) !== job.job.configuration?.policyDigest))
  ) {
    throw new ReviewFailure(
      rejected('configuration_blocked', 'Review requires unchanged approved host policy.'),
    );
  }

  if (
    task.submission.gate.overrideReason !== null &&
    value.data.execution.review?.allowGateOverride !== true
  ) {
    throw new ReviewFailure(
      rejected(
        'review_blocked',
        'Gate overrides require explicit trusted host permission and a request reason.',
      ),
    );
  }

  const role =
    job?.job.configuration?.effective.roles.reviewer ??
    value.data.local.roles?.reviewer ??
    value.data.project.roles?.reviewer;

  if (role?.runtime === 'codex-herdr') {
    const args = role.command ? value.data.execution.commands[role.command]?.args : undefined;
    const index = args?.indexOf('--sandbox') ?? -1;

    if (!args || index < 0 || args[index + 1] !== 'read-only') {
      throw new ReviewFailure(
        rejected(
          'review_blocked',
          'Static Codex review requires an approved read-only reviewer command.',
        ),
      );
    }
  }

  return configurationDigest(value.data);
}

async function target(task: ReviewTask, deps: ReviewDependencies, signal?: AbortSignal) {
  const snapshot = reviewSnapshotSchema.parse(
    read(await deps.targets.read({ target: task.submission.target, root: task.root }, signal)),
  );

  if (
    !sameReviewTarget(snapshot.target, task.submission.target) ||
    snapshot.baseSha !== task.initialSnapshot.baseSha
  ) {
    throw new ReviewFailure(
      rejected('review_target_changed', 'PR head changed; this request cannot be retargeted.'),
    );
  }

  return snapshot;
}

export async function submitReview(
  input: unknown,
  deps: ReviewDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<ReviewJob>> {
  const request = parseOperationRequest(reviewSubmitRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Review submission was cancelled.');
  }

  try {
    const value = request.value;
    const previous = read(deps.queue.reviewRequest({ projectId: value.projectId, key: value.key }));

    if (previous) {
      if (!isDeepStrictEqual(previous.submission, value)) {
        return rejected(
          'state_conflict',
          'This review request key already identifies different input.',
        );
      }

      return {
        schemaVersion: 1,
        outcome: 'persisted',
        disposition: 'existing',
        value: reviewView(previous.job),
      };
    }

    const owned = await inspectOwnedAssignment(value, deps, signal);
    const instructions = read(
      await deps.instructions.read({ root: owned.root, paths: value.instructionPaths }, signal),
    );
    const snapshot = reviewSnapshotSchema.parse(
      read(await deps.targets.read({ target: value.target, root: owned.root }, signal)),
    );

    if (!sameReviewTarget(snapshot.target, value.target)) {
      return rejected(
        'review_target_changed',
        'PR head changed; select the target explicitly again.',
      );
    }

    const task = reviewTaskSchema.parse({
      schemaVersion: 1,
      workflow: 'review',
      submission: value,
      authorization: 'manual-request',
      worktreeId: owned.managed.intent.id,
      root: owned.root,
      instructions,
      initialSnapshot: snapshot,
      resultContractVersion: 1,
    });
    const approvedDigest = await policy(task, deps, signal);
    const accepted = await submitServiceJob(
      {
        schemaVersion: 1,
        projectId: value.projectId,
        checkoutId: value.checkoutId,
        role: 'reviewer',
        key: value.key,
        branch: value.branch,
        commit: value.commit,
        request: value.request,
        task,
      },
      {
        ...deps,
        queue: {
          ...deps.queue,
          submit(assignment) {
            return assignment.job.configuration?.policyDigest === approvedDigest
              ? deps.queue.submit(assignment)
              : rejected('configuration_blocked', 'Review policy changed during acceptance.');
          },
        },
      },
      signal,
    );

    return accepted.outcome === 'persisted'
      ? { ...accepted, value: reviewView(accepted.value) }
      : accepted;
  } catch (error) {
    return error instanceof ReviewFailure || error instanceof OwnedAssignmentFailure
      ? error.result
      : rejected('review_blocked', 'Review context could not be accepted; no worker was launched.');
  }
}

/** Saved observations only, available with the service stopped. */
export function inspectReview(
  input: unknown,
  deps: Pick<ReviewDependencies, 'queue'>,
  signal?: AbortSignal,
): OperationResult<ReviewJob | null> {
  const request = parseOperationRequest(reviewReadRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Review inspection was cancelled.');
  }

  const result = deps.queue.read(request.value.jobId);

  if (result.outcome === 'rejected') {
    return result;
  }

  if (result.value === null) {
    return completed(null);
  }

  return reviewTask(result.value)
    ? completed(reviewView(result.value))
    : rejected('invalid_request', 'The selected job is not a manual review assignment.');
}

export function createReviewRuntime(input: {
  runtime: ServiceWorkerRuntime;
  dependencies: ReviewDependencies;
  workerInput: ImplementationWorkerInput;
}): ServiceWorkerRuntime {
  const delivery = createTaskDeliveryRuntime({
    ...input,
    workflow: 'review',
    inputKey: reviewInputKey,
    task: reviewTask,
    render: renderReviewPrompt,
    async readiness(job, task, signal) {
      try {
        await policy(task, input.dependencies, signal, job);

        if (task.submission.resources.length > 0) {
          return rejected(
            'review_blocked',
            'Isolated integration resources are requested; provisioning is not implemented.',
          );
        }

        const snapshot = await target(task, input.dependencies, signal);
        const blocker = reviewGateBlocker(snapshot, task.submission.gate);

        return blocker ? rejected('review_blocked', blocker) : completed({ ready: true as const });
      } catch (error) {
        return error instanceof ReviewFailure
          ? error.result
          : rejected('review_blocked', 'Review readiness could not be verified.');
      }
    },
  });
  async function observe(job: ServiceJob, signal: AbortSignal, start: boolean) {
    const observation = await (start ? delivery.start(job, signal) : delivery.inspect(job, signal));
    const task = reviewTask(job);
    const state = observation.evidence.review;

    if (
      !task ||
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      state.delivery !== 'acknowledged'
    ) {
      return observation;
    }

    // Continue observing an already authorized worker; freshness never authorizes another launch/input.
    try {
      const snapshot = await target(task, input.dependencies, signal);
      const blocker = reviewGateBlocker(snapshot, task.submission.gate);

      return {
        ...observation,
        evidence: {
          ...observation.evidence,
          reviewGate: snapshot,
          ...(blocker
            ? {
                reviewFreshness: { reason: blocker },
                review:
                  observation.state === 'unknown'
                    ? state
                    : { ...state, state: 'needs_decision', reason: blocker },
              }
            : {}),
        },
      };
    } catch (error) {
      return {
        ...observation,
        evidence: {
          ...observation.evidence,
          reviewFreshness: {
            reason:
              error instanceof ReviewFailure
                ? error.result.error.code
                : 'review_target_unavailable',
          },
          review:
            observation.state === 'unknown'
              ? state
              : {
                  ...state,
                  state: 'needs_decision',
                  reason:
                    error instanceof ReviewFailure
                      ? error.result.error.code
                      : 'review_target_unavailable',
                },
        },
      };
    }
  }

  return {
    ...delivery,
    start: (job, signal) => observe(job, signal, true),
    inspect: (job, signal) => observe(job, signal, false),
  };
}
