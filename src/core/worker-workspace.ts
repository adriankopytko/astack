import { sha256 } from './file-paths.js';

/** Stable label derived from Astack's persisted worktree identity. */
export function workerWorkspaceLabel(worktreeId: string): string {
  return `astack-${sha256(`worktree:${worktreeId}`).slice(0, 24)}`;
}
