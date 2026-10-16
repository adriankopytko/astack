import type { OperationResult } from '../contracts/operation-result.js';
import type { ProcessResult } from '../contracts/process.js';
import type { StateWriteResult } from '../contracts/state.js';
import type {
  WorktreeIntent,
  WorktreeRecord,
  WorktreeObservation,
} from '../contracts/worktrees.js';
import type { CheckoutLocation } from '../contracts/projects.js';

export interface WorktreeStore {
  read(id: string): OperationResult<WorktreeRecord | null>;
  find(projectId: string, key: string): OperationResult<WorktreeRecord | null>;
  reserve(intent: WorktreeIntent, operationId: string): StateWriteResult<WorktreeRecord>;
  beginRemoval(
    record: WorktreeRecord,
    operationId: string,
    head: string,
  ): StateWriteResult<WorktreeRecord>;
  finish(
    record: WorktreeRecord,
    phase: 'ready' | 'removed' | 'abandoned',
    location: CheckoutLocation | null,
    reconciliation: WorktreeRecord['reconciliation'],
  ): StateWriteResult<WorktreeRecord>;
}
export interface WorktreeFiles {
  prepare(intent: WorktreeIntent): Promise<void>;
  observe(intent: WorktreeIntent): Promise<Pick<WorktreeObservation, 'container' | 'checkout'>>;
}
export interface WorktreeGit {
  create(intent: WorktreeIntent, signal?: AbortSignal): Promise<ProcessResult>;
  remove(intent: WorktreeIntent, signal?: AbortSignal): Promise<ProcessResult>;
  ignored(intent: WorktreeIntent, signal?: AbortSignal): Promise<OperationResult<boolean>>;
  preflight(intent: WorktreeIntent, signal?: AbortSignal): Promise<OperationResult<null>>;
}
