import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { genericHandoffSubmissionSchema } from '../contracts/generic-handoff.js';
import { workerQueueItemSchema, workerQueueReceipt } from '../contracts/worker-queue.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import { configurationDigest } from '../core/configuration.js';
import type { WorkerQueueStore } from '../ports/worker-queue.js';
import { resolveConfiguration, type ConfigurationDependencies } from './configuration.js';

export interface HandoffContextReader {
  read(
    input: {
      reference: NonNullable<z.infer<typeof genericHandoffSubmissionSchema>['context']>;
      root: string;
    },
    signal?: AbortSignal,
  ): Promise<
    OperationResult<NonNullable<z.infer<typeof workerQueueItemSchema>['contextSnapshot']>>
  >;
}

/** Accept a generic handoff and its configuration before preparing any worker resources. */
export async function enqueueHandoff(
  input: unknown,
  deps: ConfigurationDependencies & {
    workerQueue: WorkerQueueStore;
    nextId(): string;
    now(): number;
    available?: readonly string[];
    githubContext?: HandoffContextReader;
  },
  signal?: AbortSignal,
) {
  const parsed = genericHandoffSubmissionSchema.safeParse(input);

  if (!parsed.success) {
    return rejected('invalid_request', 'Invalid handoff submission.');
  }

  const submission = parsed.data;

  if (submission.baseCommit === 'pr-head' && submission.context?.kind !== 'pr') {
    return rejected('invalid_request', 'Use --base pr-head with a pull request.');
  }

  const request = { kind: 'handoff' as const, submission };
  const prior = deps.workerQueue.find(submission.projectId, 'handoff', submission.key);

  if (prior.outcome === 'rejected') {
    return prior;
  }

  if (prior.value) {
    return isDeepStrictEqual(prior.value.request, request)
      ? {
          schemaVersion: 1 as const,
          outcome: 'persisted' as const,
          disposition: 'existing' as const,
          value: workerQueueReceipt(prior.value),
        }
      : rejected('state_conflict', 'This handoff ID already identifies a different submission.');
  }

  const project = await deps.registry.readProject(submission.projectId);

  if (project.outcome === 'rejected') {
    return project;
  }

  if (project.value?.registeredAt == null) {
    return rejected('project_not_found', 'The registered project could not be found.');
  }

  let policy: ReturnType<typeof hostConfigurationPolicySchema.safeParse>;

  try {
    policy = hostConfigurationPolicySchema.safeParse(
      await deps.configuration.readPolicy(submission.projectId, signal),
    );
  } catch {
    return rejected('configuration_unavailable', 'Project configuration could not be read.');
  }

  if (!policy.success) {
    return rejected('configuration_blocked', 'Project configuration could not be resolved.');
  }

  const config = await resolveConfiguration(
    {
      schemaVersion: 1,
      projectId: submission.projectId,
      role: submission.agent,
      request: submission.request,
    },
    deps,
    signal,
  );

  if (config.outcome === 'rejected') {
    return config;
  }

  if (config.value.status !== 'ready' || !config.value.snapshot) {
    return rejected(
      'configuration_blocked',
      `Configure the ${submission.agent} agent before submitting this task.`,
    );
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Submission was cancelled before acceptance.');
  }

  if (configurationDigest(policy.data) !== config.value.snapshot.policyDigest) {
    return rejected(
      'configuration_blocked',
      'Project configuration changed during task acceptance.',
    );
  }

  const runtime = config.value.snapshot.effective.roles[submission.agent]?.runtime;

  if (!runtime || (deps.available && !deps.available.includes(runtime))) {
    return rejected(
      'runtime_unavailable',
      'The configured agent runtime is not available in the service.',
    );
  }

  let contextSnapshot: z.infer<typeof workerQueueItemSchema>['contextSnapshot'];

  if (submission.context) {
    if (!deps.githubContext) {
      return rejected('github_unavailable', 'GitHub context reads are unavailable in the service.');
    }

    const checkout = await deps.registry.readCheckout(project.value.project.primaryCheckoutId);

    if (checkout.outcome === 'rejected') {
      return checkout;
    }

    if (!checkout.value?.registered) {
      return rejected('checkout_not_found', 'Registered project checkout not found.');
    }

    const result = await deps.githubContext.read(
      { reference: submission.context, root: checkout.value.checkout.rootPath },
      signal,
    );

    if (result.outcome === 'rejected') {
      return result;
    }

    const context = workerQueueItemSchema.shape.contextSnapshot.safeParse(result.value);
    const expected = `${submission.context.host}/${submission.context.repository}#${submission.context.number}`;

    if (
      !context.success ||
      !context.data ||
      context.data.kind !== submission.context.kind ||
      context.data.reference !== expected ||
      (context.data.kind === 'pr' && (!context.data.headSha || !context.data.baseSha))
    ) {
      return rejected('github_invalid_output', 'GitHub context was incomplete or too large.');
    }

    contextSnapshot = context.data;
  }

  const saved = deps.workerQueue.enqueue({
    id: deps.nextId(),
    request,
    policy: policy.data,
    runtime,
    ...(contextSnapshot ? { contextSnapshot } : {}),
    state: 'queued',
    jobId: null,
    error: null,
    createdAt: deps.now(),
  });

  return saved.outcome === 'persisted'
    ? { ...saved, value: workerQueueReceipt(saved.value) }
    : saved;
}
