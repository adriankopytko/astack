import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { WorkerQueueItem } from '../contracts/worker-queue.js';
import type { ServiceLimits } from '../contracts/service.js';
import type { WorktreeRecord } from '../contracts/worktrees.js';

export interface WorkerQueueStore {
  enqueue(item: WorkerQueueItem): StateWriteResult<WorkerQueueItem>;
  find(
    projectId: string,
    kind: WorkerQueueItem['request']['kind'],
    key: string,
  ): OperationResult<WorkerQueueItem | null>;
  read(id: string): OperationResult<WorkerQueueItem | null>;
  counts(): OperationResult<{ queued: number; preparing: number }>;
  reservations(
    excludeId: string,
  ): OperationResult<{ global: number; roles: Record<string, number> }>;
  claim(
    limits: ServiceLimits,
    available: Readonly<Record<string, readonly string[]>>,
  ): StateWriteResult<WorkerQueueItem | null>;
  block(id: string, error: { code: string; message: string }): StateWriteResult<WorkerQueueItem>;
  uncertain(
    id: string,
    error: { code: string; message: string },
  ): StateWriteResult<WorkerQueueItem>;
  alias(id: string, jobId: string): StateWriteResult<WorkerQueueItem>;
  reconciled(worktree: WorktreeRecord): StateWriteResult<WorkerQueueItem | null>;
  reconcileAbsent(id: string): StateWriteResult<WorkerQueueItem>;
  cancel(id: string): StateWriteResult<WorkerQueueItem>;
}
