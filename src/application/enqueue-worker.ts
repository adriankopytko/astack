import { isDeepStrictEqual } from 'node:util';
import { workerQueueRequestSchema, workerQueueReceipt } from '../contracts/worker-queue.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { rejected } from '../contracts/operation-result.js';
import { configurationDigest } from '../core/configuration.js';
import type { WorkerQueueStore } from '../ports/worker-queue.js';
import { resolveConfiguration, type ConfigurationDependencies } from './configuration.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { z } from 'zod';
import { issueReferenceSchema, issueSnapshotSchema } from '../contracts/implementation-task.js';
import { implementationWorkerSubmissionSchema } from '../contracts/worker-submission.js';

/** Save the task and its current configuration without creating a workspace. */
export async function enqueueWorker(
  input: unknown,
  deps: ConfigurationDependencies & {
    workerQueue: WorkerQueueStore;
    nextId: () => string;
    now: () => number;
    available?: Readonly<Record<string, readonly string[]>>;
    githubIssues?: {
      read(
        input: { reference: z.infer<typeof issueReferenceSchema>; root: string },
        signal?: AbortSignal,
      ): Promise<OperationResult<z.infer<typeof issueSnapshotSchema>>>;
    };
  },
  signal?: AbortSignal,
) {
  const parsed = workerQueueRequestSchema.safeParse(input);

  if (!parsed.success) {
    return rejected('invalid_request', 'Invalid worker submission.');
  }

  const request = parsed.data;

  if (request.kind === 'implementer' && request.submission.issueSnapshot) {
    return rejected(
      'invalid_request',
      'Issue snapshots are fetched by Astack, not supplied with the request.',
    );
  }

  const prior = deps.workerQueue.find(
    request.submission.projectId,
    request.kind,
    request.submission.key,
  );

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
      : rejected('state_conflict', 'This task key already identifies a different submission.');
  }

  const config = await resolveConfiguration(
    {
      schemaVersion: 1,
      projectId: request.submission.projectId,
      role: request.kind,
      request: request.submission.request,
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
      `Configure the ${request.kind} agent before submitting this task.`,
    );
  }

  let policy: ReturnType<typeof hostConfigurationPolicySchema.safeParse>;

  try {
    policy = hostConfigurationPolicySchema.safeParse(
      await deps.configuration.readPolicy(request.submission.projectId, signal),
    );
  } catch {
    return rejected('configuration_unavailable', 'Project configuration could not be read.');
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Submission was cancelled before acceptance.');
  }

  if (!policy.success || configurationDigest(policy.data) !== config.value.snapshot.policyDigest) {
    return rejected(
      'configuration_blocked',
      'Project configuration changed during task acceptance.',
    );
  }

  const runtime = config.value.snapshot.effective.roles[request.kind]?.runtime;

  if (!runtime) {
    return rejected('configuration_blocked', 'The selected agent has no runtime configured.');
  }

  if (deps.available && !deps.available[request.kind]?.includes(runtime)) {
    return rejected(
      'runtime_unavailable',
      'The configured agent runtime is not available in the service.',
    );
  }

  let issueSnapshot: z.infer<typeof issueSnapshotSchema> | undefined;

  if (request.kind === 'implementer' && request.submission.issue) {
    if (!deps.githubIssues) {
      return rejected('github_unavailable', 'GitHub issue reads are unavailable in the service.');
    }

    const project = await deps.registry.readProject(request.submission.projectId);

    if (project.outcome === 'rejected') {
      return project;
    }

    if (!project.value) {
      return rejected('project_not_found', 'Registered project not found.');
    }

    const checkout = await deps.registry.readCheckout(project.value.project.primaryCheckoutId);

    if (checkout.outcome === 'rejected') {
      return checkout;
    }

    if (!checkout.value?.registered) {
      return rejected('checkout_not_found', 'Registered project checkout not found.');
    }

    const result = await deps.githubIssues.read(
      { reference: request.submission.issue, root: checkout.value.checkout.rootPath },
      signal,
    );

    if (result.outcome === 'rejected') {
      return result;
    }

    const parsedIssue = issueSnapshotSchema.safeParse(result.value);

    if (
      !parsedIssue.success ||
      !isDeepStrictEqual(parsedIssue.data.reference, request.submission.issue)
    ) {
      return rejected(
        'github_invalid_output',
        'The issue is too large or does not match the requested repository and number.',
      );
    }

    issueSnapshot = parsedIssue.data;

    if (
      !implementationWorkerSubmissionSchema.safeParse({ ...request.submission, issueSnapshot })
        .success
    ) {
      return rejected(
        'invalid_request',
        'The task and issue content together exceed the assignment size limit.',
      );
    }
  }

  const result = deps.workerQueue.enqueue({
    id: deps.nextId(),
    request,
    policy: policy.data,
    runtime,
    ...(issueSnapshot ? { issueSnapshot } : {}),
    state: 'queued',
    jobId: null,
    error: null,
    createdAt: deps.now(),
  });

  return result.outcome === 'persisted'
    ? { ...result, value: workerQueueReceipt(result.value) }
    : result;
}
