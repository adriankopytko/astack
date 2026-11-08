import { completed, rejected } from '../contracts/operation-result.js';
import {
  worktreePrepareRequestSchema,
  worktreeReconcileRequestSchema,
  type WorktreeResult,
} from '../contracts/worktrees.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { isDeepStrictEqual } from 'node:util';
import { workerWorkspaceLabel } from '../core/worker-workspace.js';
import { ensureHerdrProject, type HerdrDependencies } from './herdr.js';
import { prepareWorktree, reconcileWorktree } from './worktrees.js';
import type { WorktreeDependencies } from './worktree-evidence.js';

/** Prepare an owned checkout and its Herdr child workspace as one provider effect. */
export async function prepareWorkerWorktree(
  input: unknown,
  dependencies: { worktrees: WorktreeDependencies; herdr: HerdrDependencies },
  signal?: AbortSignal,
): Promise<WorktreeResult> {
  const request = parseOperationRequest(worktreePrepareRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const primary = await ensureHerdrProject(
    { schemaVersion: 1, projectId: request.value.projectId },
    dependencies.herdr,
    signal,
  );

  if (
    !('record' in primary) ||
    !primary.record?.handle ||
    !['prepared', 'reused'].includes(primary.outcome)
  ) {
    return rejected(
      'herdr_unavailable',
      'The project Herdr workspace must be ready before worker setup.',
    );
  }

  if (!dependencies.herdr.provider.createWorker) {
    return rejected('herdr_unsupported', 'The Herdr provider cannot create a worker checkout.');
  }

  const workspace = primary.record;
  const create = dependencies.herdr.provider.createWorker.bind(dependencies.herdr.provider);
  const worktrees = dependencies.worktrees;

  return prepareWorktree(
    request.value,
    {
      ...worktrees,
      workspaceIntent: (id) => ({
        parentWorkspaceId: workspace.handle!.workspaceId,
        server: workspace.server,
        label: workerWorkspaceLabel(id),
      }),
      effects: {
        ...worktrees.effects,
        async create(intent, effectSignal) {
          const created = await create(
            {
              target: workspace.target,
              server: workspace.server,
              sourceRoot: intent.sourceRoot,
              root: intent.checkoutPath,
              parent: workspace.handle!.workspaceId,
              branch: intent.branch.slice('refs/heads/'.length),
              baseCommit: intent.baseCommit,
              label: workerWorkspaceLabel(intent.id),
            },
            effectSignal,
          );

          if (created.outcome === 'rejected') {
            return created;
          }

          const snapshot = await dependencies.herdr.provider.snapshot(
            workspace.target,
            intent.sourceRoot,
            effectSignal,
          );

          if (snapshot.outcome === 'rejected') {
            return snapshot;
          }

          const child = snapshot.value.workspaces.find(
            (entry) => entry.id === created.value.workspaceId,
          );

          if (
            !isDeepStrictEqual(snapshot.value.server, workspace.server) ||
            child?.label !== workerWorkspaceLabel(intent.id) ||
            child.worktree?.checkoutPath !== intent.checkoutPath ||
            child.worktree.repositoryRoot !== intent.sourceRoot ||
            !child.worktree.linked ||
            !snapshot.value.workspaces.some((entry) => entry.id === workspace.handle!.workspaceId)
          ) {
            return rejected(
              'herdr_invalid_output',
              'Herdr did not confirm the created worker workspace.',
            );
          }

          return completed({
            workspaceId: created.value.workspaceId,
            parentWorkspaceId: workspace.handle!.workspaceId,
            server: workspace.server,
            label: workerWorkspaceLabel(intent.id),
          });
        },
      },
    },
    signal,
  );
}

/** Inspect a stopped writer's exact Herdr workspace before settling an interrupted creation. */
export async function reconcileWorkerWorktree(
  input: unknown,
  dependencies: { worktrees: WorktreeDependencies; herdr: HerdrDependencies },
  signal?: AbortSignal,
): Promise<WorktreeResult> {
  const request = parseOperationRequest(worktreeReconcileRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const record = dependencies.worktrees.store.read(request.value.id);

  if (record.outcome === 'rejected') {
    return record;
  }

  if (!record.value || record.value.operationId !== request.value.operationId) {
    return rejected('worktree_conflict', 'The pending worktree and operation must match.');
  }

  const intent = record.value.intent;

  if (!intent.workspace || record.value.phase !== 'preparing') {
    return reconcileWorktree(request.value, dependencies.worktrees, signal);
  }

  const snapshot = await dependencies.herdr.provider.snapshot(
    { session: intent.workspace.server.session, socketPath: intent.workspace.server.socketPath },
    intent.sourceRoot,
    signal,
  );

  if (snapshot.outcome === 'rejected') {
    return snapshot;
  }

  const matches = snapshot.value.workspaces.filter(
    (entry) =>
      entry.label === intent.workspace!.label &&
      entry.worktree?.checkoutPath === intent.checkoutPath &&
      entry.worktree.repositoryRoot === intent.sourceRoot &&
      entry.worktree.linked,
  );

  if (
    !isDeepStrictEqual(snapshot.value.server, intent.workspace.server) ||
    matches.length > 1 ||
    !snapshot.value.workspaces.some((entry) => entry.id === intent.workspace!.parentWorkspaceId)
  ) {
    return {
      schemaVersion: 1,
      outcome: 'blocked',
      reason: 'provider_uncertain',
      record: record.value,
    };
  }

  if (matches.length === 0) {
    return reconcileWorktree(request.value, dependencies.worktrees, signal);
  }

  return reconcileWorktree(request.value, dependencies.worktrees, signal, {
    ...intent.workspace,
    workspaceId: matches[0]!.id,
  });
}
