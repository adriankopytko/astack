import type { ProcessResult } from '../contracts/process.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type {
  WorktreeObservation,
  WorktreeRecord,
  WorktreeResult,
  WorktreeReason,
} from '../contracts/worktrees.js';
import type { WorktreeFiles, WorktreeGit, WorktreeStore } from '../ports/worktrees.js';
import type { ProjectDependencies } from './project-facts.js';
import {
  ProjectFailure,
  inspectProjectPath,
  locateCheckout,
  observe,
  sameLocation,
} from './project-facts.js';
import { selectProjectContext } from './select-project-context.js';

export interface WorktreeDependencies extends ProjectDependencies {
  store: WorktreeStore;
  files: WorktreeFiles;
  effects: WorktreeGit;
  managedRoot: string;
  nextId(kind: 'worktree' | 'checkout' | 'operation' | 'marker'): string;
  now(): number;
}
export function take<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new ProjectFailure(result);
  }

  return result.value;
}

export function readWorktree(id: string, dependencies: WorktreeDependencies): WorktreeRecord {
  const record = take(dependencies.store.read(id));

  if (!record) {
    throw new ProjectFailure(
      rejected('worktree_not_found', 'The selected owned worktree does not exist.'),
    );
  }

  return record;
}

export function pending(
  record: WorktreeRecord,
  reason: WorktreeReason = 'provider_uncertain',
): WorktreeResult {
  return { schemaVersion: 1, outcome: 'pending', record, reason };
}

export function blocked(record: WorktreeRecord, reason: WorktreeReason): WorktreeResult {
  return { schemaVersion: 1, outcome: 'blocked', record, reason };
}

export function gitSucceeded(result: ProcessResult): boolean {
  return (
    result.outcome === 'exited' &&
    result.error === null &&
    result.exitCode === 0 &&
    result.signal === null &&
    result.shutdown.root === 'exited' &&
    result.shutdown.processGroup === 'absent' &&
    result.stdout.complete &&
    result.stderr.complete &&
    !result.stdout.truncated &&
    !result.stderr.truncated
  );
}

export async function worktreeEvidence(
  record: WorktreeRecord,
  dependencies: WorktreeDependencies,
  signal?: AbortSignal,
) {
  const intent = record.intent;
  const source = await observe(
    selectProjectContext(
      { schemaVersion: 1, projectId: intent.projectId, checkoutId: intent.sourceCheckoutId },
      dependencies,
      signal,
    ),
    signal,
  );

  if (
    !source.checkout?.location ||
    !sameLocation(source.checkout.location, intent.sourceLocation)
  ) {
    throw new ProjectFailure(
      rejected('project_checkout_stale', 'The worktree source checkout identity changed.'),
    );
  }

  const files = await dependencies.files.observe(intent);
  const observation: WorktreeObservation = {
    ...files,
    git: null,
    location: null,
    ignoredFiles: null,
  };

  if (files.container === 'owned' && files.checkout === 'present') {
    try {
      observation.git = await inspectProjectPath(intent.checkoutPath, dependencies, signal);
      observation.location = await locateCheckout(observation.git, dependencies, signal);
      observation.ignoredFiles = await observe(
        dependencies.effects.ignored(intent, signal),
        signal,
      );
    } catch (error) {
      if (
        !(error instanceof ProjectFailure) ||
        !['not_git_repository', 'path_unavailable', 'unsupported_repository'].includes(
          error.result.error.code,
        )
      ) {
        throw error;
      }
    }
  }

  return { observation, source };
}

export function ownedProblem(
  record: WorktreeRecord,
  evidence: Awaited<ReturnType<typeof worktreeEvidence>>,
  clean = true,
): WorktreeReason | null {
  const { intent } = record;
  const { observation, source } = evidence;
  const { git, location } = observation;
  const member = source.git.worktrees.find((tree) => tree.path === intent.checkoutPath);

  if (observation.container !== 'owned') {
    return 'unowned';
  }

  if (observation.checkout !== 'present' || !git || !location || !member) {
    return 'partial';
  }

  if (
    git.checkout.rootPath !== intent.checkoutPath ||
    git.repository.commonDirectory !== intent.sourceLocation.commonDirectory.path ||
    location.commonDirectory.device !== intent.sourceLocation.commonDirectory.device ||
    location.commonDirectory.inode !== intent.sourceLocation.commonDirectory.inode ||
    (record.location && !sameLocation(record.location, location))
  ) {
    return 'identity_changed';
  }

  if (member.locked || member.prunable) {
    return 'locked';
  }

  const head = git.checkout.head;

  if (
    head.branch !== intent.branch ||
    member.branch !== intent.branch ||
    member.detached ||
    member.bare ||
    head.commit === null ||
    git.refs.find((ref) => ref.name === intent.branch)?.objectId !== head.commit ||
    (record.phase === 'preparing' && head.commit !== intent.baseCommit) ||
    (record.phase === 'removing' && head.commit !== record.removalCommit)
  ) {
    return 'branch_changed';
  }

  if (clean && !git.status.clean) {
    return 'dirty';
  }

  if (clean && observation.ignoredFiles !== false) {
    return 'ignored_files';
  }

  return null;
}

export function worktreeFailure(
  error: unknown,
  record: WorktreeRecord | null,
  effectPossible: boolean,
): WorktreeResult {
  if (record && effectPossible) {
    return pending(record);
  }

  if (error instanceof ProjectFailure) {
    return error.result;
  }

  return record
    ? blocked(record, 'identity_changed')
    : rejected('context_source_unavailable', 'Worktree dependencies could not be read.');
}
