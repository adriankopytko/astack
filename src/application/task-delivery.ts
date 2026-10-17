import { isDeepStrictEqual } from 'node:util';
import {
  implementationProgressSchema,
  implementationInputReceiptSchema,
  implementationInputObservationSchema,
  type ImplementationProgress,
  type InstructionReference,
} from '../contracts/implementation-task.js';
import { workerInputTextSchema } from '../contracts/worker-input.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { ServiceJob, WorkerObservation } from '../contracts/service.js';
import type { ServiceWorkerRuntime } from '../ports/service.js';
import type { ImplementationWorkerInput } from '../ports/implementation.js';
import { workerInputDigest } from '../core/worker-input.js';
import { checkConfigurationDispatch } from './configuration.js';
import { inspectOwnedAssignment, OwnedAssignmentFailure } from './owned-assignment.js';
import type { ImplementationContextReader } from '../ports/implementation.js';
import type { OwnedAssignmentDependencies } from './owned-assignment.js';
export interface TaskDeliveryDependencies extends OwnedAssignmentDependencies {
  instructions: ImplementationContextReader;
}
interface DeliveryTask {
  submission: {
    projectId: string;
    checkoutId: string;
    branch: string;
    commit: string;
    instructionPaths: string[];
  };
  worktreeId: string;
  root: string;
  instructions: InstructionReference[];
}
class DeliveryFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Task delivery blocked');
  }
}
function read<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new DeliveryFailure(result);
  }

  return result.value;
}

function progress(
  state: ImplementationProgress['state'],
  delivery: ImplementationProgress['delivery'] = 'not_submitted',
  reason: string | null = null,
): ImplementationProgress {
  return { state, delivery, reason, acceptedOutcome: null };
}

/** Adds initial task delivery to a generic runtime. Receipts, not idle UI, determine whether delivery can run. */
export function createTaskDeliveryRuntime<T extends DeliveryTask>(input: {
  runtime: ServiceWorkerRuntime;
  dependencies: TaskDeliveryDependencies;
  workerInput: ImplementationWorkerInput;
  workflow: string;
  inputKey: string;
  task: (job: ServiceJob) => T | null;
  render: (job: ServiceJob, task: T) => string;
  readiness?: (
    job: ServiceJob,
    task: T,
    signal: AbortSignal,
  ) => Promise<OperationResult<{ ready: true }>>;
}): ServiceWorkerRuntime {
  const { dependencies: deps, workerInput } = input;
  function evidence(
    base: WorkerObservation,
    state: ImplementationProgress,
    uncertain = false,
  ): WorkerObservation {
    const detail = { ...base.evidence, [input.workflow]: state };

    return uncertain
      ? { state: 'unknown', handle: base.handle, evidence: detail }
      : { ...base, evidence: detail };
  }

  function receiptFor(attemptId: string) {
    const value = read(workerInput.receipt({ attemptId, key: input.inputKey }));

    if (value === null) {
      return null;
    }

    const receipt = implementationInputReceiptSchema.parse(value);

    if (receipt.key !== input.inputKey) {
      throw new DeliveryFailure(
        rejected(
          'runtime_conflict',
          'Implementation receipt key does not match the saved input scope.',
        ),
      );
    }

    return receipt;
  }

  async function observe(
    job: ServiceJob,
    start: boolean,
    signal: AbortSignal,
  ): Promise<WorkerObservation> {
    const task = input.task(job);
    const tagged = job.job.intent.task;

    if (
      !task &&
      tagged &&
      typeof tagged === 'object' &&
      !Array.isArray(tagged) &&
      tagged.workflow === input.workflow
    ) {
      return {
        state: 'unknown',
        handle: null,
        evidence: {
          [input.workflow]: progress(
            'blocked',
            'not_submitted',
            `invalid_${input.workflow}_assignment`,
          ),
        },
      };
    }

    const base = await (start
      ? input.runtime.start(job, signal)
      : input.runtime.inspect(job, signal));

    if (!task) {
      return base;
    }

    const prompt = input.render(job, task);
    const expected = workerInputDigest('input', prompt);
    let receipt;

    try {
      receipt = receiptFor(job.attempt.id);
    } catch {
      return evidence(base, progress('unknown', 'pending', 'receipt_unavailable'), true);
    }

    if (receipt && receipt.digest !== expected) {
      return evidence(base, progress('blocked', 'pending', 'input_conflict'), true);
    }

    const delivery = receipt?.state ?? 'not_submitted';

    if (base.state !== 'running') {
      return evidence(
        base,
        progress(
          base.state === 'not_started'
            ? 'failed'
            : base.state === 'quiescent'
              ? 'awaiting_result'
              : 'unknown',
          delivery,
          base.state === 'not_started' ? 'launch_refused' : 'runtime_not_verified',
        ),
      );
    }

    if (receipt?.state === 'pending') {
      return evidence(base, progress('unknown', 'pending', 'initial_input_pending'), true);
    }

    if (base.evidence.agentStatus === 'blocked') {
      return evidence(base, progress('needs_decision', delivery, 'agent_blocked'));
    }

    if (receipt?.state === 'acknowledged') {
      return evidence(base, progress('started', 'acknowledged'));
    }

    if (signal.aborted) {
      return evidence(base, progress('unknown', 'not_submitted', 'cancelled'), true);
    }

    let effectPossible = false;

    try {
      const current = read(deps.queue.read(job.job.id));

      if (!current || !isDeepStrictEqual(current, job)) {
        return evidence(base, progress('blocked', 'not_submitted', 'assignment_changed'));
      }

      const config = read(
        await checkConfigurationDispatch({ schemaVersion: 1, job: job.job }, deps, signal),
      );

      if (config.status !== 'ready') {
        return evidence(base, progress('blocked', 'not_submitted', 'configuration_blocked'));
      }

      const owned = await inspectOwnedAssignment(task.submission, deps, signal);

      if (owned.managed.intent.id !== task.worktreeId || owned.root !== task.root) {
        return evidence(base, progress('blocked', 'not_submitted', 'assignment_changed'));
      }

      const fresh = read(
        await deps.instructions.read(
          { root: task.root, paths: task.submission.instructionPaths },
          signal,
        ),
      );

      if (!isDeepStrictEqual(fresh, task.instructions)) {
        return evidence(base, progress('blocked', 'not_submitted', 'instructions_changed'));
      }

      if (!workerInputTextSchema.safeParse(prompt).success) {
        return evidence(base, progress('blocked', 'not_submitted', 'prompt_unsupported'));
      }

      if (input.readiness) {
        read(await input.readiness(job, task, signal));
      }

      effectPossible = true;
      const response = await workerInput.submit(
        { attemptId: job.attempt.id, key: input.inputKey, text: prompt },
        signal,
      );

      if (response.outcome === 'completed') {
        implementationInputObservationSchema.parse(response.value);
      }

      const freshReceipt = receiptFor(job.attempt.id);

      if (freshReceipt && freshReceipt.digest !== expected) {
        return evidence(base, progress('blocked', 'pending', 'input_conflict'), true);
      }

      if (freshReceipt?.state === 'acknowledged') {
        if (response.outcome === 'completed' && response.value.blocker === 'identity_changed') {
          return evidence(base, progress('unknown', 'acknowledged', 'identity_changed'), true);
        }

        return evidence(base, progress('started', 'acknowledged'));
      }

      if (freshReceipt) {
        return evidence(base, progress('unknown', 'pending', 'initial_input_pending'), true);
      }

      const blocker =
        response.outcome === 'completed' ? response.value.blocker : 'provider_unavailable';

      return evidence(
        base,
        progress(
          blocker === 'needs_decision' ? 'needs_decision' : 'blocked',
          'not_submitted',
          blocker ?? 'input_not_accepted',
        ),
      );
    } catch (error) {
      return !effectPossible
        ? evidence(
            base,
            progress(
              'blocked',
              'not_submitted',
              error instanceof DeliveryFailure || error instanceof OwnedAssignmentFailure
                ? error.result.error.code
                : 'context_unavailable',
            ),
          )
        : evidence(base, progress('unknown', 'pending', 'delivery_uncertain'), true);
    }
  }

  return {
    async preflight(job, signal) {
      if (input.runtime.preflight) {
        const result = await input.runtime.preflight(job, signal);

        if (result.outcome === 'rejected') {
          return result;
        }
      }

      const task = input.task(job);

      if (!task) {
        const packet = job.job.intent.task;

        return packet &&
          typeof packet === 'object' &&
          !Array.isArray(packet) &&
          packet.workflow === input.workflow
          ? rejected(
              'invalid_request',
              `A valid ${input.workflow} assignment is required for workflow preflight.`,
            )
          : completed({ ready: true as const });
      }

      if (!workerInputTextSchema.safeParse(input.render(job, task)).success) {
        return rejected('invalid_request', 'Workflow prompt exceeds the supported input contract.');
      }

      try {
        if (input.readiness) {
          read(await input.readiness(job, task, signal));
        }

        const owned = await inspectOwnedAssignment(task.submission, deps, signal);

        if (owned.managed.intent.id !== task.worktreeId || owned.root !== task.root) {
          return rejected(
            'implementation_assignment_changed',
            'Initial implementation context changed before dispatch.',
          );
        }

        const references = read(
          await deps.instructions.read(
            { root: task.root, paths: task.submission.instructionPaths },
            signal,
          ),
        );

        return owned.managed.intent.id === task.worktreeId &&
          owned.root === task.root &&
          isDeepStrictEqual(references, task.instructions)
          ? completed({ ready: true as const })
          : rejected(
              'implementation_assignment_changed',
              'Initial implementation context changed before dispatch.',
            );
      } catch (error) {
        return error instanceof DeliveryFailure || error instanceof OwnedAssignmentFailure
          ? error.result
          : rejected(
              'implementation_context_invalid',
              'Implementation context is unavailable before dispatch.',
            );
      }
    },
    id: input.runtime.id,
    workflows: [...new Set([...(input.runtime.workflows ?? []), input.workflow])],
    start: (job, signal) => observe(job, true, signal),
    inspect: (job, signal) => observe(job, false, signal),
    ...(input.runtime.subscribe === undefined
      ? {}
      : { subscribe: (wake: () => void) => input.runtime.subscribe?.(wake) ?? (() => {}) }),
  };
}

export function taskDeliveryProgress(
  job: ServiceJob,
  evidenceName: string,
): ImplementationProgress {
  let state: ImplementationProgress;

  switch (job.entry.state) {
    case 'queued':
      state = progress('queued');
      break;
    case 'dispatching':
      state = progress('starting');
      break;
    case 'blocked':
      state = progress(
        job.entry.reason === 'provider_refused' ? 'failed' : 'blocked',
        'not_submitted',
        job.entry.reason,
      );
      break;
    case 'awaiting_result':
      state = progress('awaiting_result', 'acknowledged', 'result_not_accepted');
      break;
    case 'unknown':
      state = progress('unknown', 'pending', job.entry.reason);
      break;
    case 'started':
      state = progress('unknown', 'not_submitted', 'handoff_not_observed');
      break;
  }

  const evidence = implementationProgressSchema.safeParse(
    job.entry.observation?.evidence[evidenceName],
  );

  if (job.entry.claim && job.entry.state !== 'blocked' && evidence.success) {
    state = evidence.data;
  }

  return state;
}
