import {
  completed,
  rejected,
  type OperationResult,
  type OperationError,
} from '../contracts/operation-result.js';
import {
  serviceSubmitRequestSchema,
  serviceReadRequestSchema,
  serviceEntrySchema,
  serviceLimitsSchema,
  workerObservationSchema,
  type ServiceJob,
  type ServiceLimits,
  type ServiceStatus,
  type WorkerObservation,
} from '../contracts/service.js';
import { stateJobRequestSchema, type StateWriteResult } from '../contracts/state.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { ServiceStore, ServiceWorkerRuntime } from '../ports/service.js';
import {
  resolveConfiguration,
  checkConfigurationDispatch,
  type ConfigurationDependencies,
} from './configuration.js';
import { selectProjectContext } from './select-project-context.js';

export interface ServiceDependencies extends ConfigurationDependencies {
  queue: ServiceStore;
  now: () => number;
  nextId: (kind: 'job' | 'attempt' | 'effect' | 'claim') => string;
}

export async function submitServiceJob(
  input: unknown,
  dependencies: ServiceDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<ServiceJob>> {
  const parsed = parseOperationRequest(serviceSubmitRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const request = parsed.value;
  const config = await resolveConfiguration(
    {
      schemaVersion: 1,
      projectId: request.projectId,
      role: request.role,
      request: request.request,
      ...(request.checkoutId === undefined ? {} : { checkoutId: request.checkoutId }),
    },
    dependencies,
    signal,
  );

  if (config.outcome === 'rejected') {
    return config;
  }

  if (config.value.status !== 'ready' || !config.value.snapshot) {
    return rejected(
      'configuration_blocked',
      'Inspect configuration and resolve blockers before submission.',
    );
  }

  const snapshot = config.value.snapshot;
  const job = parseOperationRequest(stateJobRequestSchema, {
    schemaVersion: 1,
    job: {
      id: dependencies.nextId('job'),
      projectId: snapshot.projectId,
      repositoryId: snapshot.repositoryId,
      checkoutId: snapshot.checkoutId,
      requester: 'local-host',
      operation: `delegate:${request.role}`,
      idempotencyKey: request.key,
      createdAt: dependencies.now(),
      configuration: snapshot,
      intent: {
        branch: request.branch,
        commit: request.commit,
        role: request.role,
        task: request.task,
      },
    },
  });

  if (!job.valid) {
    return job.result;
  }

  const entry = serviceEntrySchema.safeParse({
    jobId: job.value.job.id,
    attemptId: dependencies.nextId('attempt'),
    effectId: dependencies.nextId('effect'),
    role: request.role,
    branch: request.branch,
    commit: request.commit,
    state: 'queued',
    reason: null,
    claim: null,
    observation: null,
  });

  if (!entry.success) {
    return rejected('invalid_request', 'Host identifiers do not match the service contract.');
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Submission was cancelled before persistence.');
  }

  return dependencies.queue.submit({ job: job.value.job, entry: entry.data });
}

const activeStates = new Set(['dispatching', 'started', 'unknown']);

export function inspectServiceJob(
  input: unknown,
  store: ServiceStore,
  signal?: AbortSignal,
): OperationResult<ServiceJob | null> {
  const parsed = parseOperationRequest(serviceReadRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  return signal?.aborted
    ? rejected('cancelled', 'Job inspection was cancelled.')
    : store.read(parsed.value.jobId);
}

/** One serial effect dispatcher under externally held coordinator ownership. No timer/provider polling. */
export function createServiceCoordinator(input: {
  sessionId: string;
  limits: ServiceLimits;
  runtimes: readonly ServiceWorkerRuntime[];
  dependencies: ServiceDependencies;
  onFailure: () => void;
}) {
  const limits = serviceLimitsSchema.parse(input.limits);
  const runtimes = new Map(input.runtimes.map((runtime) => [runtime.id, runtime]));
  const controller = new AbortController();
  let phase: ServiceStatus['phase'] = 'recovering';
  let pending = false;
  let running: Promise<void> | null = null;
  let failed = false;
  let started = false;
  const { dependencies } = input;

  if (runtimes.size !== input.runtimes.length) {
    throw new Error('Runtime IDs must be unique');
  }

  function runtime(job: ServiceJob): ServiceWorkerRuntime | undefined {
    const id = job.job.configuration?.effective.roles[job.entry.role]?.runtime;

    return id ? runtimes.get(id) : undefined;
  }

  function written<T>(result: StateWriteResult<T>): T {
    if (result.outcome !== 'persisted') {
      throw new Error('Service state requires inspection before continuing');
    }

    return result.value;
  }

  async function visit(action: (job: ServiceJob) => Promise<void>): Promise<void> {
    let after: string | undefined;

    do {
      const page = dependencies.queue.list(after);

      if (page.outcome === 'rejected') {
        throw new Error('Service queue could not be inspected');
      }

      for (const job of page.value.items) {
        if (controller.signal.aborted) {
          return;
        }

        await action(job);
      }

      after = page.value.nextCursor ?? undefined;
    } while (after !== undefined);
  }

  async function observe(job: ServiceJob, start: boolean): Promise<void> {
    const saved = dependencies.queue.read(job.job.id);

    if (saved.outcome !== 'completed' || !saved.value) {
      throw new Error('Dispatch assignment unavailable');
    }

    job = saved.value;

    if (start && job.entry.control && job.entry.control.phase !== 'active') {
      return;
    }

    const provider = runtime(job);
    let observation: WorkerObservation;

    try {
      observation = provider
        ? workerObservationSchema.parse(
            await (start
              ? provider.start(job, controller.signal)
              : provider.inspect(job, controller.signal)),
          )
        : {
            state: 'unknown',
            handle: job.entry.observation?.handle ?? null,
            evidence: { reason: 'runtime_unavailable' },
          };
    } catch {
      observation = {
        state: 'unknown',
        handle: job.entry.observation?.handle ?? null,
        evidence: { reason: 'provider_uncertain' },
      };
    }

    written(dependencies.queue.observe(job.job.id, observation, dependencies.now()));
  }

  async function cycle(): Promise<void> {
    // Always inspect existing effects before assigning capacity to new writers.
    await visit(async (job) => {
      if (activeStates.has(job.entry.state)) {
        await observe(job, false);
      }
    });

    if (controller.signal.aborted) {
      return;
    }

    phase = 'running';
    await visit(async (job) => {
      if (
        (job.entry.control && job.entry.control.phase !== 'active') ||
        job.entry.claim !== null ||
        !['queued', 'blocked'].includes(job.entry.state)
      ) {
        return;
      }

      const config = await checkConfigurationDispatch(
        { schemaVersion: 1, job: job.job },
        dependencies,
        controller.signal,
      );

      if (controller.signal.aborted) {
        return;
      }

      if (config.outcome !== 'completed' || config.value.status !== 'ready') {
        written(dependencies.queue.block(job.job.id, 'configuration_blocked'));

        return;
      }

      if (!runtime(job)) {
        written(dependencies.queue.block(job.job.id, 'runtime_unavailable'));

        return;
      }

      const task = job.job.intent.task;
      const workflow =
        task && typeof task === 'object' && !Array.isArray(task) ? task.workflow : null;

      if (typeof workflow === 'string' && !runtime(job)?.workflows?.includes(workflow)) {
        written(dependencies.queue.block(job.job.id, 'workflow_unavailable'));

        return;
      }

      const selected = await selectProjectContext(
        { schemaVersion: 1, projectId: job.job.projectId, checkoutId: job.job.checkoutId },
        dependencies,
        controller.signal,
      );

      if (controller.signal.aborted) {
        return;
      }

      if (
        selected.outcome !== 'completed' ||
        selected.value.git.checkout.head.commit !== job.entry.commit ||
        selected.value.git.checkout.head.branch !== job.entry.branch
      ) {
        written(dependencies.queue.block(job.job.id, 'assignment_changed'));

        return;
      }

      const provider = runtime(job);

      if (provider?.preflight) {
        let ready = false;
        let readiness: OperationError | undefined;

        try {
          const result = await provider.preflight(job, controller.signal);
          ready = result.outcome === 'completed' && result.value.ready === true;

          if (result.outcome === 'rejected') {
            readiness = result.error;
          }
        } catch {
          ready = false;
        }

        if (controller.signal.aborted) {
          return;
        }

        if (!ready) {
          written(dependencies.queue.block(job.job.id, 'workflow_blocked', readiness));

          return;
        }
      }

      const claimed = written(
        dependencies.queue.claim({
          jobId: job.job.id,
          owner: input.sessionId,
          token: dependencies.nextId('claim'),
          now: dependencies.now(),
          limits,
        }),
      );

      if (claimed) {
        await observe(claimed, true);
      }
    });
  }

  function wake(): void {
    if (controller.signal.aborted || failed) {
      return;
    }

    pending = true;

    if (running) {
      return;
    }

    running = (async () => {
      try {
        while (pending && !controller.signal.aborted) {
          pending = false;
          await cycle();
        }
      } catch {
        failed = true;
        phase = 'stopping';
        controller.abort();
        input.onFailure();
      } finally {
        running = null;
      }
    })();
  }

  const unsubscribe: (() => void)[] = [];

  return {
    start(): void {
      if (started || controller.signal.aborted) {
        return;
      }

      started = true;

      try {
        for (const provider of input.runtimes) {
          const remove = provider.subscribe?.(wake);

          if (remove) {
            unsubscribe.push(remove);
          }
        }

        wake();
      } catch {
        failed = true;
        controller.abort();
        input.onFailure();
      }
    },
    wake,
    async idle(): Promise<void> {
      while (running) {
        await running;
      }
    },
    status(): OperationResult<ServiceStatus> {
      const counts: ServiceStatus['counts'] = {
        queued: 0,
        dispatching: 0,
        started: 0,
        awaiting_result: 0,
        blocked: 0,
        unknown: 0,
      };
      let after: string | undefined;

      do {
        const page = dependencies.queue.list(after);

        if (page.outcome === 'rejected') {
          return page;
        }

        for (const job of page.value.items) {
          counts[job.entry.state]++;
        }

        after = page.value.nextCursor ?? undefined;
      } while (after !== undefined);

      return completed({
        sessionId: input.sessionId,
        phase,
        limits,
        runtimes: [...runtimes.keys()],
        counts,
      });
    },
    async stop(): Promise<void> {
      phase = 'stopping';
      controller.abort();

      let removalFailed = false;

      for (const remove of unsubscribe) {
        try {
          remove();
        } catch {
          removalFailed = true;
        }
      }

      while (running) {
        await running;
      }

      if (removalFailed) {
        throw new Error('Runtime notification cleanup failed after draining effects');
      }
    },
  };
}
