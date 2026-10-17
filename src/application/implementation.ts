import { isDeepStrictEqual } from 'node:util';
import {
  implementationSubmitRequestSchema,
  implementationReadRequestSchema,
  implementationTaskSchema,
  implementationProgressSchema,
  implementationInputReceiptSchema,
  implementationInputObservationSchema,
  type ImplementationTask,
  type ImplementationJob,
  type ImplementationProgress,
} from '../contracts/implementation.js';
import { workerInputTextSchema } from '../contracts/worker-input.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { ServiceJob, WorkerObservation } from '../contracts/service.js';
import type { ServiceWorkerRuntime } from '../ports/service.js';
import type { WorktreeStore, WorktreeFiles } from '../ports/worktrees.js';
import type {
  ImplementationContextReader,
  ImplementationWorkerInput,
} from '../ports/implementation.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import {
  renderImplementationPrompt,
  implementationInputKey,
} from '../core/implementation-prompt.js';
import { workerInputDigest } from '../core/worker-input.js';
import { submitServiceJob, type ServiceDependencies } from './service.js';
import { checkConfigurationDispatch } from './configuration.js';
import { selectProjectContext } from './select-project-context.js';

export interface ImplementationDependencies extends ServiceDependencies {
  worktrees: WorktreeStore;
  files: WorktreeFiles;
  instructions: ImplementationContextReader;
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

function progress(
  state: ImplementationProgress['state'],
  delivery: ImplementationProgress['delivery'] = 'not_submitted',
  reason: string | null = null,
): ImplementationProgress {
  return { state, delivery, reason, acceptedOutcome: null };
}

export function implementationView(job: ServiceJob): ImplementationJob {
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
    job.entry.observation?.evidence.implementation,
  );

  if (job.entry.claim && job.entry.state !== 'blocked' && evidence.success) {
    state = evidence.data;
  }

  return { job, implementation: state };
}

async function checkout(
  input: { projectId: string; checkoutId: string; branch: string; commit: string },
  deps: ImplementationDependencies,
  signal?: AbortSignal,
  initial = true,
) {
  const selected = read(
    await selectProjectContext(
      { schemaVersion: 1, projectId: input.projectId, checkoutId: input.checkoutId },
      deps,
      signal,
    ),
  );
  const managed = read(deps.worktrees.forCheckout(input.checkoutId));

  if (
    !managed ||
    managed.phase !== 'ready' ||
    managed.intent.projectId !== input.projectId ||
    managed.intent.repositoryId !== selected.project?.repository.id ||
    managed.intent.checkoutPath !== selected.checkout?.checkout.rootPath ||
    !isDeepStrictEqual(managed.location, selected.checkout?.location) ||
    managed.intent.branch !== input.branch ||
    selected.git.checkout.head.branch !== input.branch ||
    (initial && (selected.git.checkout.head.commit !== input.commit || !selected.git.status.clean))
  ) {
    throw new ImplementationFailure(
      rejected(
        'implementation_assignment_changed',
        'Select a clean, ready owned checkout at the exact initial branch and commit.',
      ),
    );
  }

  const files = await deps.files.observe(managed.intent);

  if (files.container !== 'owned' || files.checkout !== 'present') {
    throw new ImplementationFailure(
      rejected(
        'implementation_assignment_changed',
        'Owned checkout evidence changed; preserve the resource and inspect it.',
      ),
    );
  }

  return { selected, managed, root: managed.intent.checkoutPath };
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

    const owned = await checkout(value, deps, signal);
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
    return error instanceof ImplementationFailure
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

/** Adds initial task delivery to a generic runtime. Receipts, not idle UI, determine whether delivery can run. */
export function createImplementationRuntime(input: {
  runtime: ServiceWorkerRuntime;
  dependencies: ImplementationDependencies;
  workerInput: ImplementationWorkerInput;
}): ServiceWorkerRuntime {
  const { dependencies: deps, workerInput } = input;
  function evidence(
    base: WorkerObservation,
    state: ImplementationProgress,
    uncertain = false,
  ): WorkerObservation {
    const detail = { ...base.evidence, implementation: state };

    return uncertain
      ? { state: 'unknown', handle: base.handle, evidence: detail }
      : { ...base, evidence: detail };
  }

  function receiptFor(attemptId: string) {
    const value = read(workerInput.receipt({ attemptId, key: implementationInputKey }));

    if (value === null) {
      return null;
    }

    const receipt = implementationInputReceiptSchema.parse(value);

    if (receipt.key !== implementationInputKey) {
      throw new ImplementationFailure(
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
    const task = implementationTask(job);
    const tagged = job.job.intent.task;

    if (
      !task &&
      tagged &&
      typeof tagged === 'object' &&
      !Array.isArray(tagged) &&
      tagged.workflow === 'implementation'
    ) {
      return {
        state: 'unknown',
        handle: null,
        evidence: {
          implementation: progress('blocked', 'not_submitted', 'invalid_implementation_assignment'),
        },
      };
    }

    const base = await (start
      ? input.runtime.start(job, signal)
      : input.runtime.inspect(job, signal));

    if (!task) {
      return base;
    }

    const prompt = renderImplementationPrompt(job, task);
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

      const owned = await checkout(task.submission, deps, signal);

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

      effectPossible = true;
      const response = await workerInput.submit(
        { attemptId: job.attempt.id, key: implementationInputKey, text: prompt },
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
              error instanceof ImplementationFailure
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

      const task = implementationTask(job);

      if (!task) {
        const packet = job.job.intent.task;

        return packet &&
          typeof packet === 'object' &&
          !Array.isArray(packet) &&
          packet.workflow === 'implementation'
          ? rejected(
              'invalid_request',
              'A valid implementation assignment is required for workflow preflight.',
            )
          : completed({ ready: true as const });
      }

      try {
        const owned = await checkout(task.submission, deps, signal);

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
        return error instanceof ImplementationFailure
          ? error.result
          : rejected(
              'implementation_context_invalid',
              'Implementation context is unavailable before dispatch.',
            );
      }
    },
    id: input.runtime.id,
    workflows: [...new Set([...(input.runtime.workflows ?? []), 'implementation'])],
    start: (job, signal) => observe(job, true, signal),
    inspect: (job, signal) => observe(job, false, signal),
    ...(input.runtime.subscribe === undefined
      ? {}
      : { subscribe: (wake: () => void) => input.runtime.subscribe?.(wake) ?? (() => {}) }),
  };
}
