import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  runtimeRequestSchema,
  runtimeInputRequestSchema,
  runtimeInterruptRequestSchema,
  runtimeSessionSchema,
  runtimeCapabilities,
  type RuntimeSession,
  type RuntimeStatus,
  type RuntimeAction,
} from '../contracts/runtime.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { ServiceJob, WorkerObservation } from '../contracts/service.js';
import type { RuntimeStore, InteractiveWorkerProvider } from '../ports/runtime.js';
import type { ServiceStore, ServiceWorkerRuntime } from '../ports/service.js';
import { workerInputDigest } from '../core/worker-input.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { configurationDigest } from '../core/configuration.js';
import { checkConfigurationDispatch } from './configuration.js';
import { prepareHerdrWorker, inspectHerdrWorker, bindHerdrAgent } from './herdr.js';
import { selectProjectContext } from './select-project-context.js';
import type { HerdrDependencies } from './herdr.js';

export interface RuntimeDependencies extends HerdrDependencies {
  runtime: RuntimeStore;
  queue: ServiceStore;
  worker: InteractiveWorkerProvider;
  /** Host opt-in attests that the selected Herdr server resolves canonical `codex` to this approved executable. */
  canonicalCodexExecutable: string;
}
class RuntimeFailure extends Error {
  constructor(readonly result: OperationResult<never>) {
    super('Runtime operation blocked');
  }
}
function read<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new RuntimeFailure(result);
  }

  return result.value;
}

function write<T>(result: StateWriteResult<T>): T {
  if (result.outcome !== 'persisted') {
    throw new RuntimeFailure(
      rejected(
        result.outcome === 'uncertain' ? 'state_reconciliation_required' : result.error.code,
        result.error.message,
      ),
    );
  }

  return result.value;
}

function status(
  session: RuntimeSession | null,
  state: RuntimeStatus['state'],
  reason: RuntimeStatus['reason'] = null,
  agentStatus: RuntimeStatus['agentStatus'] = null,
  action: RuntimeAction | null = null,
): OperationResult<RuntimeStatus> {
  return completed({ session, state, reason, agentStatus, action });
}

async function perform<T extends z.ZodType>(
  schema: T,
  input: unknown,
  signal: AbortSignal | undefined,
  action: (request: z.output<T>) => Promise<OperationResult<RuntimeStatus>>,
): Promise<OperationResult<RuntimeStatus>> {
  const request = parseOperationRequest(schema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Runtime operation was cancelled before execution.');
  }

  try {
    return await action(request.value);
  } catch (error) {
    return error instanceof RuntimeFailure
      ? error.result
      : rejected(
          'runtime_unavailable',
          'Runtime evidence is unavailable; preserve saved intent and inspect before retrying.',
        );
  }
}

function controlSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);

  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function jobFor(attemptId: string, deps: RuntimeDependencies): Promise<ServiceJob> {
  const run = read(await deps.registry.readRun(attemptId));
  const job = run ? read(deps.queue.read(run.jobId)) : null;
  const attempt = read(
    deps.state.inspectRecord({ schemaVersion: 1, entity: 'attempt', id: attemptId }),
  );

  if (
    !job ||
    job.attempt.id !== attemptId ||
    !job.entry.claim ||
    !['dispatching', 'started', 'unknown'].includes(job.entry.state) ||
    attempt?.entity !== 'attempt' ||
    attempt.resolvedAt !== null
  ) {
    throw new RuntimeFailure(
      rejected(
        'runtime_conflict',
        'Runtime writes require an unresolved, capacity-claimed saved service attempt.',
      ),
    );
  }

  return job;
}

async function approved(job: ServiceJob, deps: RuntimeDependencies, signal?: AbortSignal) {
  const check = read(
    await checkConfigurationDispatch({ schemaVersion: 1, job: job.job }, deps, signal),
  );

  if (check.status !== 'ready' || !job.job.configuration) {
    throw new RuntimeFailure(
      rejected(
        'configuration_blocked',
        'Refresh the accepted runtime policy before controlling this worker.',
      ),
    );
  }

  const policy = hostConfigurationPolicySchema.parse(
    await deps.configuration.readPolicy(job.job.projectId, signal),
  );

  if (configurationDigest(policy) !== job.job.configuration.policyDigest) {
    throw new RuntimeFailure(
      rejected('configuration_blocked', 'Host policy changed during runtime authorization.'),
    );
  }

  const effective = job.job.configuration.effective;
  const role = effective.roles[job.entry.role];
  const command = role?.command ? policy.execution.commands[role.command] : undefined;

  if (
    !role ||
    role.runtime !== runtimeCapabilities.runtime ||
    !command ||
    command.executable !== deps.canonicalCodexExecutable
  ) {
    throw new RuntimeFailure(
      rejected(
        'configuration_blocked',
        'Approve the canonical Codex executable and codex-herdr runtime for this role.',
      ),
    );
  }

  if (
    role.environment.length ||
    role.skills.length ||
    Object.values(effective.hooks).some((hook) => hook !== null) ||
    role.timeoutMs < 5000
  ) {
    throw new RuntimeFailure(
      rejected(
        'runtime_capability_missing',
        'This runtime cannot provision explicit environment, pinned skills or hooks; control timeouts must be at least five seconds.',
      ),
    );
  }

  // Only bounded interactive execution controls are supported. No initial prompt, resume, remote, config or bypass flags.
  const args = command.args;
  const expected = new Map<string, string | null>([
    ['--sandbox', null],
    ['--ask-for-approval', null],
    ['--no-daemon', null],
    ['--no-alt-screen', null],
  ]);

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];

    if (!flag || !expected.has(flag)) {
      throw new RuntimeFailure(
        rejected(
          'runtime_capability_missing',
          'Approved Codex arguments exceed this interactive runtime capability.',
        ),
      );
    }

    expected.delete(flag);

    if (flag === '--sandbox' && !['read-only', 'workspace-write'].includes(args[++index] ?? '')) {
      throw new RuntimeFailure(
        rejected('runtime_capability_missing', 'Select read-only or workspace-write sandbox mode.'),
      );
    }

    if (flag === '--ask-for-approval' && !['on-request', 'never'].includes(args[++index] ?? '')) {
      throw new RuntimeFailure(
        rejected('runtime_capability_missing', 'Select an explicit supported approval mode.'),
      );
    }
  }

  if (expected.size) {
    throw new RuntimeFailure(
      rejected(
        'runtime_capability_missing',
        'Explicit sandbox, approval, no-daemon and no-alt-screen controls are required.',
      ),
    );
  }

  return { args: [...args], timeoutMs: Math.min(role.timeoutMs, 30_000) };
}

async function observed(session: RuntimeSession, deps: RuntimeDependencies, signal?: AbortSignal) {
  const saved = read(deps.herdr.worker(session.attemptId));

  if (!saved || !isDeepStrictEqual({ ...saved, agent: session.space.agent }, session.space)) {
    return null;
  }

  const result = await inspectHerdrWorker(
    { schemaVersion: 1, attemptId: session.attemptId },
    deps,
    signal,
  );

  if (
    !('observation' in result) ||
    result.reason ||
    !result.observation?.agent ||
    result.observation.agent.kind !== 'codex' ||
    !result.observation.agent.nativeSessionId ||
    (session.agent && !isDeepStrictEqual(result.observation.agent, session.agent))
  ) {
    return null;
  }

  return result.observation;
}

/** Read-only provider observation; idle/done are never accepted completion or verified process shutdown. */
export async function inspectRuntime(
  input: unknown,
  deps: RuntimeDependencies,
  signal?: AbortSignal,
) {
  return perform(runtimeRequestSchema, input, signal, async ({ attemptId }) => {
    const session = read(deps.runtime.read(attemptId));

    if (!session) {
      return status(null, 'not_started', 'not_launched');
    }

    const observation = await observed(session, deps, signal);

    if (!observation) {
      return status(session, 'unknown', 'identity_changed');
    }

    const action = read(deps.runtime.pending(attemptId));

    if (session.phase === 'pending') {
      return status(session, 'unknown', 'launch_pending', observation.agentStatus, action);
    }

    if (action) {
      return status(session, 'unknown', 'action_pending', observation.agentStatus, action);
    }

    return status(
      session,
      'running',
      observation.agentStatus === 'blocked' ? 'agent_blocked' : null,
      observation.agentStatus,
    );
  });
}

/** Reconcile only observed launch identity. Never reissues a launch or guesses prompt delivery from UI state. */
export async function reconcileRuntime(
  input: unknown,
  deps: RuntimeDependencies,
  signal?: AbortSignal,
) {
  return perform(runtimeRequestSchema, input, signal, async ({ attemptId }) => {
    const session = read(deps.runtime.read(attemptId));

    if (!session || session.phase === 'ready') {
      return inspectRuntime(input, deps, signal);
    }

    const observation = await observed(session, deps, signal);

    if (!observation?.agent) {
      return status(session, 'unknown', 'launch_pending');
    }

    const bound = await bindHerdrAgent(
      { schemaVersion: 1, attemptId, kind: 'codex' },
      deps,
      signal,
    );

    if (
      !('record' in bound) ||
      bound.reason ||
      !bound.record?.agent ||
      !isDeepStrictEqual(bound.record.agent, observation.agent)
    ) {
      return status(session, 'unknown', 'identity_changed');
    }

    write(deps.runtime.bind(session, { ...session, phase: 'ready', agent: observation.agent }));

    return inspectRuntime(input, deps, signal);
  });
}

export async function launchRuntime(
  input: unknown,
  deps: RuntimeDependencies,
  signal?: AbortSignal,
) {
  return perform(runtimeRequestSchema, input, signal, async ({ attemptId }) => {
    // A repeated start is inspection only, including a crash before the provider call.
    if (read(deps.runtime.read(attemptId))) {
      return reconcileRuntime(input, deps, signal);
    }

    const job = await jobFor(attemptId, deps);
    const command = await approved(job, deps, signal);
    const layout = await prepareHerdrWorker(input, deps, signal);

    if (
      !('record' in layout) ||
      !layout.record ||
      layout.reason ||
      !['prepared', 'reused'].includes(layout.outcome)
    ) {
      return status(null, 'blocked', 'provider_unavailable');
    }

    const space = layout.record;
    const selected = read(
      await selectProjectContext({ schemaVersion: 1, runId: attemptId }, deps, signal),
    );
    const snapshot = read(await deps.provider.snapshot(space.target, space.root, signal));

    if (
      space.agent ||
      selected.git.checkout.head.commit !== job.entry.commit ||
      selected.git.checkout.head.branch !== job.entry.branch ||
      snapshot.agents.some(
        (agent) =>
          agent.kind !== null &&
          (agent.paneId === space.handle?.paneId || agent.name === space.expectedAgentName),
      )
    ) {
      return status(null, 'blocked', 'identity_changed');
    }

    await approved(await jobFor(attemptId, deps), deps, signal);

    if (signal?.aborted) {
      return rejected('cancelled', 'Runtime launch was cancelled before acceptance.');
    }

    const session = runtimeSessionSchema.parse({
      schemaVersion: 1,
      runtime: runtimeCapabilities.runtime,
      launchId: `launch-${createHash('sha256').update(`${attemptId}:${job.entry.effectId}`).digest('hex').slice(0, 32)}`,
      jobId: job.job.id,
      attemptId,
      effectId: job.entry.effectId,
      space,
      phase: 'pending',
      agent: null,
    });
    const reserved = deps.runtime.reserve(session);
    write(reserved);

    if (reserved.outcome !== 'persisted' || reserved.disposition !== 'created') {
      return reconcileRuntime(input, deps, signal);
    }

    try {
      // Persistence precedes the only launch call. Cancellation/timeout after this point leaves unknown intent.
      const launched = await deps.worker.launch(
        { space, ...command },
        controlSignal(command.timeoutMs, signal),
      );

      if (launched.outcome === 'rejected') {
        return status(session, 'unknown', 'launch_pending');
      }

      return await reconcileRuntime(input, deps, signal);
    } catch {
      return status(session, 'unknown', 'launch_pending');
    }
  });
}

async function control(
  input: unknown,
  deps: RuntimeDependencies,
  kind: RuntimeAction['kind'],
  signal?: AbortSignal,
) {
  const schema = kind === 'input' ? runtimeInputRequestSchema : runtimeInterruptRequestSchema;

  return perform(schema, input, signal, async (request) => {
    const { attemptId, key } = request;
    const text = 'text' in request && typeof request.text === 'string' ? request.text : '';
    const digest = workerInputDigest(kind, text);
    const existing = read(deps.runtime.action(attemptId, key));
    const session = read(deps.runtime.read(attemptId));

    if (existing) {
      if (existing.kind !== kind || existing.digest !== digest) {
        return rejected('runtime_conflict', 'Action key was already used with different input.');
      }

      if (existing.state === 'pending') {
        return status(session, 'unknown', 'action_pending', null, existing);
      }

      const fresh = read(await inspectRuntime({ schemaVersion: 1, attemptId }, deps, signal));

      return status(
        fresh.session,
        fresh.state,
        fresh.state === 'running' ? 'action_acknowledged' : fresh.reason,
        fresh.agentStatus,
        existing,
      );
    }

    if (!session || session.phase !== 'ready') {
      return status(session, 'blocked', 'launch_pending');
    }

    const job = await jobFor(attemptId, deps);
    const command = await approved(job, deps, signal);
    const observation = await observed(session, deps, signal);

    if (!observation?.agent) {
      return status(session, 'unknown', 'identity_changed');
    }

    const pending = read(deps.runtime.pending(attemptId));

    if (pending) {
      return status(session, 'unknown', 'action_pending', observation.agentStatus, pending);
    }

    if (
      observation.agentStatus === 'blocked' ||
      observation.agentStatus === 'unknown' ||
      (kind === 'input' && observation.agentStatus !== 'idle' && observation.agentStatus !== 'done')
    ) {
      return status(
        session,
        'blocked',
        observation.agentStatus === 'blocked'
          ? 'agent_blocked'
          : observation.agentStatus === 'unknown'
            ? 'agent_unknown'
            : 'agent_busy',
        observation.agentStatus,
      );
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Runtime control was cancelled before acceptance.');
    }

    const action: RuntimeAction = { attemptId, key, kind, digest, state: 'pending' };
    const reserved = deps.runtime.reserveAction(session, action);
    write(reserved);

    if (reserved.outcome !== 'persisted' || reserved.disposition !== 'created') {
      return status(
        session,
        'unknown',
        'action_pending',
        observation.agentStatus,
        reserved.outcome === 'persisted' ? reserved.value : action,
      );
    }

    try {
      const bound = { ...session.space, agent: session.agent };
      const response =
        kind === 'input'
          ? await deps.worker.input(bound, text, controlSignal(command.timeoutMs, signal))
          : await deps.worker.interrupt(bound, controlSignal(command.timeoutMs, signal));

      if (response.outcome === 'rejected') {
        return status(session, 'unknown', 'action_pending', null, action);
      }

      const saved = write(deps.runtime.acknowledge(action));

      const fresh = read(await inspectRuntime({ schemaVersion: 1, attemptId }, deps, signal));

      return status(
        fresh.session,
        fresh.state,
        fresh.state === 'running' ? 'action_acknowledged' : fresh.reason,
        fresh.agentStatus,
        saved,
      );
    } catch {
      return status(session, 'unknown', 'action_pending', null, action);
    }
  });
}

export const inputRuntime = (input: unknown, deps: RuntimeDependencies, signal?: AbortSignal) =>
  control(input, deps, 'input', signal);
export const interruptRuntime = (input: unknown, deps: RuntimeDependencies, signal?: AbortSignal) =>
  control(input, deps, 'interrupt', signal);

/** Consumes saved jobs only. Starting the interactive session does not deliver the workflow task. */
export function createCodexHerdrRuntime(deps: RuntimeDependencies): ServiceWorkerRuntime {
  async function observation(
    job: ServiceJob,
    start: boolean,
    signal: AbortSignal,
  ): Promise<WorkerObservation> {
    const saved = read(deps.queue.read(job.job.id));

    if (!saved || !isDeepStrictEqual(saved, job)) {
      return { state: 'unknown', handle: null, evidence: { reason: 'assignment_changed' } };
    }

    const result = await (start ? launchRuntime : reconcileRuntime)(
      { schemaVersion: 1, attemptId: saved.attempt.id },
      deps,
      signal,
    );

    if (result.outcome === 'rejected') {
      return { state: 'unknown', handle: null, evidence: { reason: result.error.code } };
    }

    const value = result.value;
    const identity = value.session
      ? {
          runtime: value.session.runtime,
          launchId: value.session.launchId,
          spaceId: value.session.space.id,
        }
      : null;
    // Resource handles are immutable. Native agent identity is reconciled separately in the session record.
    const previous = saved.entry.observation?.handle;
    const handle =
      identity &&
      previous &&
      previous.runtime === identity.runtime &&
      previous.launchId === identity.launchId &&
      previous.spaceId === identity.spaceId
        ? previous
        : identity;
    const evidence = {
      reason: value.reason,
      agentStatus: value.agentStatus,
      acceptedCompletion: false,
    };

    return value.state === 'running' && handle
      ? { state: 'running', handle, evidence }
      : { state: 'unknown', handle, evidence };
  }

  return {
    id: runtimeCapabilities.runtime,
    start: (job, signal) => observation(job, true, signal),
    inspect: (job, signal) => observation(job, false, signal),
  };
}
