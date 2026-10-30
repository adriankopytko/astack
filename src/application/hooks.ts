import { isDeepStrictEqual } from 'node:util';
import {
  hookRequestSchema,
  hookRecordSchema,
  hookSelectorSchema,
  hookReconcileSchema,
  hookExcludeSchema,
  type HookRecord,
  type HookRequest,
  type HookProcessEvidence,
} from '../contracts/hooks.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { reviewTaskSchema } from '../contracts/review-task.js';
import { processResultSchema } from '../contracts/process.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { AllocationRecord } from '../contracts/resources.js';
import type { HookStore, HookEnvironment } from '../ports/hooks.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { ServiceStore } from '../ports/service.js';
import type { AllocationStore, PortProbe } from '../ports/resources.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { configurationDigest } from '../core/configuration.js';
import { checkConfigurationDispatch, type ConfigurationDependencies } from './configuration.js';
import {
  inspectOwnedAssignment,
  OwnedAssignmentFailure,
  type OwnedAssignmentReaderDependencies,
} from './owned-assignment.js';
import { startAllocation } from './resources.js';
import { executeProcess } from './execute-process.js';
export interface HookDependencies
  extends ConfigurationDependencies, OwnedAssignmentReaderDependencies {
  hooks: HookStore;
  queue: ServiceStore;
  allocations: AllocationStore;
  ports: PortProbe;
  runner: ProcessRunner;
  environment: HookEnvironment;
  now(): number;
}
class HookFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Hook prerequisites unavailable');
  }
}
function value<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new HookFailure(result);
  }

  return result.value;
}

function blocked(message: string): never {
  throw new HookFailure(rejected('hook_blocked', message));
}

function identifier(request: HookRequest) {
  return `hook-${configurationDigest({ attemptId: request.attemptId, key: request.key })}`;
}

function startupKey(hookId: string, allocationId: string) {
  return `start-${configurationDigest({ hookId, allocationId })}`;
}

function selectedJob(request: HookRequest, deps: HookDependencies) {
  const job = value(deps.queue.read(request.jobId));

  if (!job || job.attempt.id !== request.attemptId || job.entry.attemptId !== request.attemptId) {
    blocked('Select the exact saved job and attempt; ambient checkout context is not a target.');
  }

  return job;
}

async function preflight(
  request: HookRequest,
  deps: HookDependencies,
  signal?: AbortSignal,
  controller?: string,
) {
  const job = selectedJob(request, deps);
  const configuration = value(
    await checkConfigurationDispatch({ schemaVersion: 1, job: job.job }, deps, signal),
  );

  if (configuration.status !== 'ready' || !configuration.snapshot) {
    blocked(
      'Inspect configuration and restore the accepted host-approved policy before executing hooks.',
    );
  }

  const inspected = await inspectOwnedAssignment(
    {
      projectId: job.job.projectId,
      checkoutId: job.job.checkoutId,
      branch: job.entry.branch,
      commit: request.commit,
    },
    deps,
    signal,
    false,
  );

  if (inspected.selected.git.checkout.head.commit !== request.commit) {
    blocked('The assigned checkout must remain on the explicit full hook commit.');
  }

  const policy = hostConfigurationPolicySchema.parse(
    await deps.configuration.readPolicy(job.job.projectId, signal),
  );

  if (
    configurationDigest(policy) !== configuration.snapshot.policyDigest ||
    policy.projectId !== job.job.projectId ||
    policy.repositoryId !== job.job.repositoryId
  ) {
    blocked('Host hook policy changed during inspection.');
  }

  const roleVerification = policy.execution.verification?.[configuration.snapshot.role];
  const named =
    request.verificationCheck === undefined
      ? undefined
      : roleVerification?.checks[request.verificationCheck];
  const commandId =
    request.verificationCheck === undefined
      ? configuration.snapshot.effective.hooks[request.phase]
      : named?.command;
  const settings =
    request.verificationCheck === undefined ? policy.execution.hooks?.[request.phase] : named;

  if (!commandId || !settings || settings.command !== commandId) {
    blocked(
      `Configure the ${request.phase} hook selection and its matching private execution.hooks policy; no default command is invented.`,
    );
  }

  const command = Object.hasOwn(policy.execution.commands, commandId)
    ? policy.execution.commands[commandId]
    : undefined;

  if (!command || settings.timeoutMs > policy.execution.maxTimeoutMs) {
    blocked('The selected hook command or deadline is not approved by the host.');
  }

  const names = [...new Set([...settings.environment, ...Object.keys(settings.resources)])].sort();

  if (
    names.length > 64 ||
    names.some((name) => !policy.execution.allowedEnvironment.includes(name)) ||
    settings.environment.some((name) => Object.hasOwn(settings.resources, name))
  ) {
    blocked(
      'Approve hook environment names and keep host values distinct from allocated resource inputs.',
    );
  }

  const selected: AllocationRecord[] = [];

  for (const ref of request.allocations) {
    const allocation = value(deps.allocations.inspect(ref.id));

    if (
      !allocation ||
      allocation.request.jobId !== job.job.id ||
      allocation.request.attemptId !== job.attempt.id ||
      allocation.binding.checkoutId !== job.job.checkoutId ||
      allocation.phase === 'released'
    ) {
      blocked('Hook resources must belong to this exact attempt and checkout.');
    }

    const ownStartup =
      controller &&
      allocation.startup?.controller === controller &&
      allocation.startup.key === startupKey(controller, allocation.id) &&
      allocation.phase === 'starting';

    if (allocation.revision !== ref.expectedRevision && !ownStartup) {
      blocked('Allocated resource revisions changed; inspect rather than retargeting hook inputs.');
    }

    if (
      request.phase === 'start' &&
      !(allocation.phase === 'reserved' && allocation.startup === null) &&
      !ownStartup
    ) {
      blocked('Start hooks need reserved resources or their own newly issued startup receipts.');
    }

    selected.push(allocation);
  }

  const required = new Set(Object.values(settings.resources).map((binding) => binding.key));

  if (selected.length !== required.size || selected.some((a) => !required.has(a.request.key))) {
    blocked('Supply exactly the resource keys declared by private hook policy.');
  }

  const review = reviewTaskSchema.safeParse(job.job.intent.task);

  if (
    job.job.operation === 'delegate:reviewer' &&
    (!review.success ||
      selected.some((a) => !review.data.submission.resources.includes(a.request.key)))
  ) {
    blocked('Integration review resources must be declared by the saved review assignment.');
  }

  const environment = value(await deps.environment.read(settings.environment));

  if (
    !isDeepStrictEqual(
      Object.keys(environment).sort(),
      [...new Set(settings.environment)].sort(),
    ) ||
    Object.values(environment).some((v) => typeof v !== 'string' || v.includes('\0'))
  ) {
    blocked('The host must supply exactly the approved hook environment values.');
  }

  const pairs = Object.entries(settings.resources).map(([name, binding]) => {
    const allocation = selected.find((a) => a.request.key === binding.key)!;
    const allocated = allocation.value;

    if (
      (allocated.kind === 'name' && binding.field !== 'name') ||
      (allocated.kind === 'port' && binding.field === 'name')
    ) {
      blocked('Resource field selection must match the allocated kind.');
    }

    const output =
      binding.field === 'name' && allocated.kind === 'name'
        ? allocated.name
        : allocated.kind === 'port' && binding.field !== 'name'
          ? String(allocated[binding.field])
          : blocked('Unsupported allocated input.');

    return [name, output] as const;
  });

  return {
    job,
    inspected,
    policy,
    commandId,
    settings,
    names,
    selected,
    environment: { ...environment, ...Object.fromEntries(pairs) },
    command,
  };
}

export function inspectHook(input: unknown, deps: Pick<HookDependencies, 'hooks'>) {
  const parsed = parseOperationRequest(hookSelectorSchema, input);

  return parsed.valid ? deps.hooks.read(parsed.value.id) : parsed.result;
}

export function reconcileHook(input: unknown, deps: Pick<HookDependencies, 'hooks'>) {
  const parsed = parseOperationRequest(hookReconcileSchema, input);

  return parsed.valid ? deps.hooks.reconcile(parsed.value) : parsed.result;
}

/** Host holds coordinator ownership and excludes checkout/startup writers throughout execution. */
export async function executeHook(
  input: unknown,
  deps: HookDependencies,
  signal?: AbortSignal,
): Promise<
  StateWriteResult<HookRecord> | { schemaVersion: 1; outcome: 'skipped'; reason: 'static_review' }
> {
  const parsed = parseOperationRequest(hookRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Hook cancelled before intent or effects.');
  }

  const request = parsed.value;
  let claimed: HookRecord | null = null;
  let invoked = false;

  try {
    const id = identifier(request);
    const old = value(deps.hooks.read(id));

    if (old) {
      if (!isDeepStrictEqual(old.request, request)) {
        blocked('The hook key already belongs to a different immutable request.');
      }

      if (old.status !== 'prepared' || old.shutdown) {
        return { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: old };
      }
    }

    const job = selectedJob(request, deps);
    const review = reviewTaskSchema.safeParse(job.job.intent.task);

    if (
      review.success &&
      review.data.submission.resources.length === 0 &&
      request.phase !== 'verify'
    ) {
      return { schemaVersion: 1, outcome: 'skipped', reason: 'static_review' };
    }

    const checked = await preflight(request, deps, signal);

    if (signal?.aborted) {
      return rejected('cancelled', 'Hook cancelled before intent or effects.');
    }

    const timestamp = deps.now();
    const proposed = hookRecordSchema.parse({
      schemaVersion: 1,
      id,
      request,
      binding: {
        projectId: job.job.projectId,
        repositoryId: job.job.repositoryId,
        checkoutId: job.job.checkoutId,
        branch: job.entry.branch,
        commit: request.commit,
      },
      worktreeId: checked.inspected.managed.intent.id,
      root: checked.inspected.root,
      location: checked.inspected.managed.location,
      policyDigest: configurationDigest(checked.policy),
      commandDigest: configurationDigest(checked.command),
      command: checked.commandId,
      timeoutMs: checked.settings.timeoutMs,
      environmentNames: checked.names,
      status: 'prepared',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      result: null,
      endpoints: [],
      reason: null,
      shutdown: null,
      writerExclusion: null,
    });
    const prepared = deps.hooks.prepare(proposed);

    if (prepared.outcome !== 'persisted') {
      return prepared;
    }

    if (
      !isDeepStrictEqual(
        { ...prepared.value, createdAt: timestamp, updatedAt: timestamp },
        proposed,
      )
    ) {
      blocked('Prepared hook evidence changed; inspect the saved invocation.');
    }

    const claim = deps.hooks.claim(id, prepared.value.revision);

    if (claim.outcome !== 'persisted') {
      return claim;
    }

    claimed = claim.value;

    if (request.phase === 'start') {
      for (const ref of request.allocations) {
        const receipt = await startAllocation(
          {
            schemaVersion: 1,
            id: ref.id,
            expectedRevision: ref.expectedRevision,
            key: startupKey(id, ref.id),
            controller: id,
          },
          deps,
          signal,
        );

        if (
          receipt.outcome !== 'persisted' ||
          receipt.disposition !== 'updated' ||
          receipt.value.phase !== 'starting'
        ) {
          blocked(
            'A resource startup receipt was not newly confirmed; preserve partial claims and do not run the hook.',
          );
        }
      }
    }

    const fresh = await preflight(request, deps, signal, id);

    if (
      !isDeepStrictEqual(fresh.inspected.managed.location, claimed.location) ||
      configurationDigest(fresh.command) !== claimed.commandDigest ||
      signal?.aborted
    ) {
      blocked('Hook execution prerequisites changed after claim.');
    }

    invoked = true;
    const process = processResultSchema.parse(
      await executeProcess(
        {
          schemaVersion: 1,
          executable: fresh.command.executable,
          args: fresh.command.args,
          cwd: claimed.root,
          env: fresh.environment,
          timeoutMs: claimed.timeoutMs,
          maxCaptureBytes: 0,
          terminationGraceMs: 250,
          shutdownWaitMs: 1000,
        },
        deps.runner,
        signal,
      ),
    );
    let status: HookRecord['status'] = 'unknown';
    let reason: HookRecord['reason'] = 'process_uncertain';
    let result: HookProcessEvidence | null = null;

    if (process.outcome !== 'rejected') {
      result = {
        outcome: process.outcome,
        exitCode: process.exitCode,
        signal: process.signal,
        shutdown: process.shutdown,
        stdout: { observedBytes: process.stdout.observedBytes, complete: process.stdout.complete },
        stderr: { observedBytes: process.stderr.observedBytes, complete: process.stderr.complete },
      };
      const settled =
        ['not_started', 'exited'].includes(process.shutdown.root) &&
        ['not_started', 'absent'].includes(process.shutdown.processGroup) &&
        process.stdout.complete &&
        process.stderr.complete;

      if (settled) {
        status =
          process.outcome === 'cancelled'
            ? 'cancelled'
            : process.outcome === 'exited' && process.exitCode === 0
              ? 'succeeded'
              : 'failed';
        reason =
          status === 'succeeded' ? null : status === 'cancelled' ? 'cancelled' : 'process_failed';
      }
    } else {
      status = 'failed';
      reason = 'process_failed';
    }

    try {
      const target = await inspectOwnedAssignment(
        {
          projectId: claimed.binding.projectId,
          checkoutId: claimed.binding.checkoutId,
          branch: claimed.binding.branch,
          commit: request.commit,
        },
        deps,
        undefined,
        false,
      );

      if (
        target.selected.git.checkout.head.commit !== request.commit ||
        !isDeepStrictEqual(target.managed.location, claimed.location)
      ) {
        throw new Error('changed');
      }
    } catch {
      if (status === 'succeeded') {
        status = 'failed';
        reason = 'target_changed';
      }
    }

    const endpoints: HookRecord['endpoints'] = [];

    for (const ref of request.allocations) {
      const allocation = value(deps.allocations.inspect(ref.id));
      let observation: HookRecord['endpoints'][number]['observation'] = 'unknown';

      if (allocation?.value.kind === 'name') {
        observation = 'not_probed';
      } else if (allocation?.value.kind === 'port') {
        try {
          const observed = await deps.ports.inspect(allocation.value);
          observation = observed.outcome === 'completed' ? observed.value : 'unknown';
        } catch {
          observation = 'unknown';
        }
      }

      endpoints.push({ id: ref.id, observation });
    }

    return deps.hooks.finish(
      {
        ...claimed,
        status,
        reason,
        result,
        endpoints,
        revision: claimed.revision + 1,
        updatedAt: deps.now(),
      },
      claimed.revision,
    );
  } catch (error) {
    if (claimed) {
      return deps.hooks.finish(
        {
          ...claimed,
          status: invoked ? 'unknown' : signal?.aborted ? 'cancelled' : 'failed',
          reason: invoked
            ? 'process_uncertain'
            : signal?.aborted
              ? 'cancelled'
              : 'prerequisites_changed',
          revision: claimed.revision + 1,
          updatedAt: deps.now(),
        },
        claimed.revision,
      );
    }

    return error instanceof HookFailure || error instanceof OwnedAssignmentFailure
      ? error.result
      : rejected(
          'hook_unavailable',
          'Hook prerequisites could not be inspected; no command was authorized.',
        );
  }
}

export function excludeHookWriter(input: unknown, deps: Pick<HookDependencies, 'hooks'>) {
  const parsed = parseOperationRequest(hookExcludeSchema, input);

  return parsed.valid ? deps.hooks.excludeWriter(parsed.value) : parsed.result;
}
