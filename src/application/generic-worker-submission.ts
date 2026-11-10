import {
  genericHandoffSubmissionSchema,
  genericHandoffTaskSchema,
} from '../contracts/generic-handoff.js';
import { rejected } from '../contracts/operation-result.js';
import { workerWorktreeKey } from '../core/worker-key.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { selectProjectContext } from './select-project-context.js';
import { resolveConfiguration } from './configuration.js';
import { prepareWorkerWorktree } from './worker-worktree.js';
import { submitGenericHandoff } from './generic-handoff.js';
import type { TaskDeliveryDependencies } from './task-delivery.js';
import type { HerdrDependencies } from './herdr.js';
import type { WorktreeDependencies } from './worktree-evidence.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { WorkerQueueItem } from '../contracts/worker-queue.js';
import type { PullRequestCommitTarget } from '../contracts/task-context.js';

/** Prepare a dedicated checkout only after queue capacity has been reserved. */
export async function submitGenericWorker(
  input: unknown,
  deps: {
    assignment: TaskDeliveryDependencies;
    worktrees: WorktreeDependencies;
    herdr: HerdrDependencies;
    baseResolver: {
      resolve(root: string, signal?: AbortSignal): Promise<OperationResult<string>>;
    };
    contextPath?: string;
    stateDirectory: string;
    contextSnapshot?: WorkerQueueItem['contextSnapshot'];
    pullRequestCommits?: {
      ensure(
        target: PullRequestCommitTarget,
        root: string,
        signal?: AbortSignal,
        comparisonBase?: string,
      ): Promise<OperationResult<null>>;
    };
    baseCommitFetcher?: {
      ensure(root: string, sha: string, signal?: AbortSignal): Promise<OperationResult<null>>;
    };
  },
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(genericHandoffSubmissionSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const request = parsed.value;
  const requestedBase =
    request.baseCommit === 'pr-head' ? deps.contextSnapshot?.headSha : request.baseCommit;

  if (request.baseCommit === 'pr-head' && !requestedBase) {
    return rejected(
      'github_invalid_output',
      'The saved PR context does not contain a head commit.',
    );
  }

  const key = workerWorktreeKey('handoff', request);
  const existing = deps.worktrees.store.find(request.projectId, key);

  if (existing.outcome === 'rejected') {
    return existing;
  }

  const source = await selectProjectContext(
    { schemaVersion: 1, projectId: request.projectId },
    deps.worktrees,
    signal,
  );

  if (source.outcome === 'rejected') {
    return source;
  }

  if (request.context?.kind === 'pr' && deps.contextSnapshot?.headSha && deps.pullRequestCommits) {
    const target = { ...request.context, sha: deps.contextSnapshot.headSha };
    const fetched = await deps.pullRequestCommits.ensure(
      { host: target.host, repository: target.repository, number: target.number, sha: target.sha },
      source.value.git.checkout.rootPath,
      signal,
      deps.contextSnapshot.baseSha,
    );

    if (fetched.outcome === 'rejected') {
      return fetched;
    }

    if (
      requestedBase &&
      requestedBase !== target.sha &&
      requestedBase !== deps.contextSnapshot.baseSha
    ) {
      const selected = await deps.pullRequestCommits.ensure(
        {
          host: target.host,
          repository: target.repository,
          number: target.number,
          sha: target.sha,
        },
        source.value.git.checkout.rootPath,
        signal,
        requestedBase,
      );

      if (selected.outcome === 'rejected') {
        return selected;
      }
    }
  }

  if (requestedBase && request.context?.kind !== 'pr' && deps.baseCommitFetcher) {
    const fetched = await deps.baseCommitFetcher.ensure(
      source.value.git.checkout.rootPath,
      requestedBase,
      signal,
    );

    if (fetched.outcome === 'rejected') {
      return fetched;
    }
  }

  let base = requestedBase ?? existing.value?.intent.baseCommit;

  if (!base) {
    const resolved = await deps.baseResolver.resolve(source.value.git.checkout.rootPath, signal);

    if (resolved.outcome === 'rejected') {
      return resolved;
    }

    base = resolved.value;
  }

  const branch = `refs/heads/astack/handoff-${key.slice(-32)}`;
  const config = await resolveConfiguration(
    {
      schemaVersion: 1,
      projectId: request.projectId,
      role: request.agent,
      request: request.request,
    },
    deps.assignment,
    signal,
  );

  if (config.outcome === 'rejected') {
    return config;
  }

  if (config.value.status !== 'ready') {
    return rejected(
      'configuration_blocked',
      `Configure the ${request.agent} agent before starting this handoff.`,
    );
  }

  const tree = await prepareWorkerWorktree(
    { schemaVersion: 1, projectId: request.projectId, key, branch, baseCommit: base },
    {
      worktrees: deps.worktrees,
      herdr: deps.herdr,
      ...(config.value.snapshot?.effective.roles[request.agent]?.workspacePrefix
        ? {
            workspacePrefix: config.value.snapshot.effective.roles[request.agent]!.workspacePrefix!,
          }
        : {}),
    },
    signal,
  );

  if (tree.outcome === 'rejected' || tree.outcome === 'uncertain') {
    return tree;
  }

  if ((tree.outcome !== 'prepared' && tree.outcome !== 'reused') || !tree.record.location) {
    return rejected(
      'state_reconciliation_required',
      `Worker setup is ${tree.outcome}; inspect its saved worktree.`,
    );
  }

  const instructions = await deps.assignment.instructions.read(
    { root: tree.record.intent.checkoutPath, paths: request.instructionPaths },
    signal,
  );

  if (instructions.outcome === 'rejected') {
    return instructions;
  }

  const task = genericHandoffTaskSchema.parse({
    schemaVersion: 1,
    workflow: 'handoff',
    submission: { ...request, checkoutId: tree.record.intent.checkoutId, branch, commit: base },
    worktreeId: tree.record.intent.id,
    root: tree.record.intent.checkoutPath,
    instructions: instructions.value,
    stateDirectory: deps.stateDirectory,
    ...(deps.contextPath ? { contextPath: deps.contextPath } : {}),
  });

  return submitGenericHandoff(task, deps.assignment, signal);
}
