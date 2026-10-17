import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type {
  HerdrResult,
  HerdrSettings,
  HerdrSpace,
  HerdrSnapshot,
  HerdrHandle,
  HerdrReason,
  HerdrAgent,
} from '../contracts/herdr.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { HerdrStore, HerdrProvider } from '../ports/herdr.js';
import type { StateStore } from '../ports/state-store.js';
import type { WorktreeFiles } from '../ports/worktrees.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { selectProjectContext } from './select-project-context.js';
import type { ConfigurationDependencies } from './configuration.js';

export interface HerdrDependencies extends ConfigurationDependencies {
  state: StateStore;
  herdr: HerdrStore;
  provider: HerdrProvider;
  files: WorktreeFiles;
  newId: () => string;
}
export class HerdrFailure extends Error {
  constructor(readonly result: HerdrResult) {
    super('Herdr operation could not complete');
  }
}
export function read<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new HerdrFailure(result);
  }

  return result.value;
}

export function persisted<T>(result: StateWriteResult<T>): T {
  if (result.outcome !== 'persisted') {
    throw new HerdrFailure(result);
  }

  return result.value;
}

export function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function result(
  outcome: 'prepared' | 'reused' | 'inspected' | 'reconciled' | 'blocked' | 'pending',
  record: HerdrSpace | null,
  reason: HerdrReason | null = null,
  observation: Extract<HerdrResult, { record: unknown }>['observation'] = null,
): HerdrResult {
  return { schemaVersion: 1, outcome, record, reason, observation };
}

export async function perform<T extends z.ZodType>(
  schema: T,
  input: unknown,
  signal: AbortSignal | undefined,
  action: (value: z.output<T>) => Promise<HerdrResult>,
): Promise<HerdrResult> {
  const request = parseOperationRequest(schema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Herdr operation was cancelled before execution.');
  }

  try {
    return await action(request.value);
  } catch (error) {
    return error instanceof HerdrFailure
      ? error.result
      : rejected(
          'herdr_unavailable',
          'Herdr evidence could not be inspected; preserve resources and pending intent.',
        );
  }
}

export function configured(projectId: string, dependencies: HerdrDependencies): HerdrSettings {
  return (
    read(dependencies.herdr.settings(projectId)) ??
    (() => {
      throw new HerdrFailure(
        rejected(
          'herdr_not_configured',
          'Configure the project Herdr target explicitly; no ambient session or fallback is used.',
        ),
      );
    })()
  );
}

export async function project(
  config: HerdrSettings,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
) {
  const selected = read(
    await selectProjectContext(
      { schemaVersion: 1, projectId: config.projectId, checkoutId: config.primaryCheckoutId },
      dependencies,
      signal,
    ),
  );

  if (
    selected.project?.repository.id !== config.repositoryId ||
    selected.project.project.primaryCheckoutId !== config.primaryCheckoutId ||
    selected.checkout?.checkout.rootPath !== config.root ||
    !same(selected.checkout.location, config.location)
  ) {
    throw new HerdrFailure(
      rejected(
        'project_checkout_stale',
        'Saved Herdr project identity changed; reconcile registration before creating layouts.',
      ),
    );
  }

  return selected;
}

export function matching(snapshot: HerdrSnapshot, root: string, kind: HerdrSpace['kind']) {
  return snapshot.workspaces.filter((workspace) => {
    if (workspace.worktree) {
      return (
        workspace.worktree.checkoutPath === root &&
        workspace.worktree.linked === (kind === 'worker') &&
        (kind !== 'primary' || workspace.worktree.repositoryRoot === root)
      );
    }

    if (kind === 'worker') {
      return false;
    }

    const panes = snapshot.panes.filter((pane) => pane.workspaceId === workspace.id);

    return panes.length > 0 && panes.every((pane) => pane.cwd === root);
  });
}

export function selectedHandle(
  snapshot: HerdrSnapshot,
  workspaceId: string,
  root: string,
  preferred?: HerdrHandle | null,
): HerdrHandle | null {
  const panes = snapshot.panes.filter(
    (pane) => pane.workspaceId === workspaceId && pane.cwd === root,
  );
  const pane =
    panes.find(
      (pane) =>
        preferred &&
        same(
          {
            workspaceId: pane.workspaceId,
            tabId: pane.tabId,
            paneId: pane.paneId,
            terminalId: pane.terminalId,
          },
          preferred,
        ),
    ) ?? panes[0];

  return pane
    ? {
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        paneId: pane.paneId,
        terminalId: pane.terminalId,
      }
    : null;
}

export function observe(
  record: HerdrSpace,
  snapshot: HerdrSnapshot,
): {
  reason: HerdrReason | null;
  observation: Extract<HerdrResult, { record: unknown }>['observation'];
} {
  const empty = { server: snapshot.server, handle: null, agent: null, agentStatus: null };

  if (!same(record.server, snapshot.server)) {
    return { reason: 'server_changed', observation: empty };
  }

  const candidates = matching(snapshot, record.root, record.kind);

  if (candidates.length !== 1) {
    return { reason: candidates.length ? 'ambiguous' : 'layout_missing', observation: empty };
  }

  const candidate = candidates[0];
  const handle = candidate
    ? selectedHandle(snapshot, candidate.id, record.root, record.handle)
    : null;

  if (!handle || (record.handle !== null && !same(record.handle, handle))) {
    return { reason: 'layout_changed', observation: empty };
  }

  if (record.kind === 'worker') {
    const primary = snapshot.workspaces.find(
      (workspace) => workspace.id === record.primaryWorkspaceId,
    );

    if (
      !primary ||
      !candidate?.worktree ||
      !primary.worktree ||
      candidate.worktree.repositoryKey !== primary.worktree.repositoryKey ||
      candidate.worktree.repositoryRoot !== primary.worktree.repositoryRoot ||
      primary.worktree.checkoutPath !== record.primaryRoot ||
      primary.worktree.repositoryRoot !== record.primaryRoot ||
      primary.worktree.linked
    ) {
      return { reason: 'layout_changed', observation: empty };
    }
  }

  const occupant = snapshot.agents.find((agent) => agent.paneId === handle.paneId);
  let agent: HerdrAgent | null = null;

  if (record.kind === 'worker' && occupant?.kind !== null && occupant?.kind !== undefined) {
    if (
      !occupant.name ||
      occupant.name !== record.expectedAgentName ||
      occupant.cwd !== record.root ||
      occupant.foregroundCwd !== record.root ||
      occupant.terminalId !== handle.terminalId ||
      (record.agent &&
        (occupant.kind !== record.agent.kind ||
          (record.agent.nativeSessionId !== null &&
            occupant.nativeSessionId !== record.agent.nativeSessionId)))
    ) {
      return { reason: 'agent_mismatch', observation: { ...empty, handle } };
    }

    agent = { name: occupant.name, kind: occupant.kind, nativeSessionId: occupant.nativeSessionId };
  } else if (record.agent !== null) {
    return { reason: 'agent_mismatch', observation: { ...empty, handle } };
  }

  return {
    reason: null,
    observation: {
      server: snapshot.server,
      handle,
      agent,
      agentStatus: agent ? (occupant?.status ?? null) : null,
    },
  };
}

export async function workerContext(
  record: HerdrSpace,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
) {
  const selected = read(
    await selectProjectContext(
      { schemaVersion: 1, projectId: record.projectId, checkoutId: record.checkoutId },
      dependencies,
      signal,
    ),
  );
  const managed = read(dependencies.herdr.managedCheckout(record.checkoutId));

  if (
    !managed ||
    managed.phase !== 'ready' ||
    !same(managed.location, record.location) ||
    selected.project?.repository.id !== record.repositoryId ||
    !same(selected.checkout?.location, record.location)
  ) {
    throw new HerdrFailure(result('blocked', record, 'managed_checkout_required'));
  }

  if (selected.git.checkout.head.branch !== record.branch) {
    throw new HerdrFailure(result('blocked', record, 'assignment_changed'));
  }

  const files = await dependencies.files.observe(managed.intent);

  if (files.container !== 'owned' || files.checkout !== 'present') {
    throw new HerdrFailure(result('blocked', record, 'managed_checkout_required'));
  }

  return selected;
}
