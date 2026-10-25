import type { RunStore } from '../ports/runs.js';
import { acceptedReviewResult } from '../core/review-result.js';
import { configurationDigest } from '../core/configuration.js';
import { isDeepStrictEqual } from 'node:util';
import {
  implementationSubmitRequestSchema,
  implementationReadRequestSchema,
  implementationTaskSchema,
  type ImplementationTask,
  type ImplementationJob,
} from '../contracts/implementation.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { ServiceJob } from '../contracts/service.js';
import type { ImplementationWorkerInput } from '../ports/implementation.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import {
  renderImplementationPrompt,
  implementationInputKey,
} from '../core/implementation-prompt.js';
import { submitServiceJob } from './service.js';
import { inspectOwnedAssignment, OwnedAssignmentFailure } from './owned-assignment.js';
import {
  createTaskDeliveryRuntime,
  taskDeliveryProgress,
  type TaskDeliveryDependencies,
} from './task-delivery.js';

export interface ImplementationDependencies extends TaskDeliveryDependencies {
  runs?: Pick<RunStore, 'inspect' | 'report'>;
}
class ImplementationFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Implementation operation blocked');
  }
}
function read<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new ImplementationFailure(result);
  }

  return result.value;
}

export function implementationTask(job: ServiceJob): ImplementationTask | null {
  const parsed = implementationTaskSchema.safeParse(job.job.intent.task);

  if (!parsed.success) {
    return null;
  }

  const task = parsed.data;
  const request = task.submission;

  return job.entry.role === 'implementer' &&
    job.job.operation === 'delegate:implementer' &&
    request.projectId === job.job.projectId &&
    request.checkoutId === job.job.checkoutId &&
    request.key === job.job.idempotencyKey &&
    request.branch === job.entry.branch &&
    request.commit === job.entry.commit
    ? task
    : null;
}

export function implementationView(job: ServiceJob): ImplementationJob {
  return { job, implementation: taskDeliveryProgress(job, 'implementation') };
}

export async function submitImplementation(
  input: unknown,
  deps: ImplementationDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<ImplementationJob>> {
  const request = parseOperationRequest(implementationSubmitRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Implementation submission was cancelled.');
  }

  try {
    const value = request.value;
    const previous = read(
      deps.queue.find({ projectId: value.projectId, role: 'implementer', key: value.key }),
    );

    if (previous) {
      const task = implementationTask(previous);

      if (!task || !isDeepStrictEqual(task.submission, value)) {
        return rejected(
          'state_conflict',
          'This implementation key already identifies a different submission.',
        );
      }

      return {
        schemaVersion: 1,
        outcome: 'persisted',
        disposition: 'existing',
        value: implementationView(previous),
      };
    }

    if (value.fixOf) {
      const reference = value.fixOf;
      const report = deps.runs
        ? read(deps.runs.report(reference.jobId, reference.reportKey))
        : null;
      const run = deps.runs ? read(deps.runs.inspect(reference.jobId)) : null;
      const source = run && report ? acceptedReviewResult(run.job, report) : null;

      if (
        !source ||
        !run ||
        !report ||
        report.id !== reference.reportId ||
        report.attemptId !== reference.attemptId ||
        configurationDigest(report) !== reference.reportDigest ||
        value.projectId !== run.job.job.projectId ||
        value.commit !== reference.commit ||
        reference.commit !== source.proposal.target.sha ||
        reference.findingIndexes.some((index) => !source.proposal.findings[index]) ||
        value.checkoutId === run.job.job.checkoutId
      ) {
        return rejected(
          'run_report_invalid',
          'Fix delegation requires an accepted same-project review result, exact commit, valid findings and a separate owned checkout.',
        );
      }
    }

    const owned = await inspectOwnedAssignment(value, deps, signal);
    const instructions = read(
      await deps.instructions.read({ root: owned.root, paths: value.instructionPaths }, signal),
    );
    const task = implementationTaskSchema.parse({
      schemaVersion: 1,
      workflow: 'implementation',
      submission: value,
      worktreeId: owned.managed.intent.id,
      root: owned.root,
      instructions,
      resultContractVersion: 1,
    });
    const accepted = await submitServiceJob(
      {
        schemaVersion: 1,
        projectId: value.projectId,
        checkoutId: value.checkoutId,
        role: 'implementer',
        key: value.key,
        branch: value.branch,
        commit: value.commit,
        request: value.request,
        task,
      },
      deps,
      signal,
    );

    return accepted.outcome === 'persisted'
      ? { ...accepted, value: implementationView(accepted.value) }
      : accepted;
  } catch (error) {
    return error instanceof ImplementationFailure || error instanceof OwnedAssignmentFailure
      ? error.result
      : rejected(
          'implementation_context_invalid',
          'Implementation context could not be accepted; no worker was launched.',
        );
  }
}

/** Saved coordinator observations only; this is not live provider inspection or result acceptance. */
export function inspectImplementation(
  input: unknown,
  deps: Pick<ImplementationDependencies, 'queue'>,
  signal?: AbortSignal,
): OperationResult<ImplementationJob | null> {
  const request = parseOperationRequest(implementationReadRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Implementation inspection was cancelled.');
  }

  const result = deps.queue.read(request.value.jobId);

  if (result.outcome === 'rejected') {
    return result;
  }

  if (!result.value) {
    return completed(null);
  }

  return implementationTask(result.value)
    ? completed(implementationView(result.value))
    : rejected('invalid_request', 'The selected job is not a versioned implementation assignment.');
}

/** Implementation profile for the shared durable initial-input delivery mechanism. */
export function createImplementationRuntime(input: {
  runtime: import('../ports/service.js').ServiceWorkerRuntime;
  dependencies: ImplementationDependencies;
  workerInput: ImplementationWorkerInput;
}): import('../ports/service.js').ServiceWorkerRuntime {
  return createTaskDeliveryRuntime({
    ...input,
    workflow: 'implementation',
    inputKey: implementationInputKey,
    task: implementationTask,
    render: renderImplementationPrompt,
  });
}
