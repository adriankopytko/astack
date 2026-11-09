import { completed } from '../contracts/operation-result.js';
import { workerQueueReceipt } from '../contracts/worker-queue.js';
import { workerWorktreeKey } from '../core/worker-key.js';
import type { WorkerQueueStore } from '../ports/worker-queue.js';
import type { WorktreeStore } from '../ports/worktrees.js';

/** Include known setup identity so interrupted work can be inspected and reconciled. */
export function inspectQueuedWorker(id: string, queue: WorkerQueueStore, worktrees: WorktreeStore) {
  const item = queue.read(id);

  if (item.outcome === 'rejected') {
    return item;
  }

  if (!item.value) {
    return completed(null);
  }

  const tree = worktrees.find(
    item.value.request.submission.projectId,
    workerWorktreeKey(item.value.request.kind, item.value.request.submission),
  );

  if (tree.outcome === 'rejected') {
    return tree;
  }

  return completed({
    ...workerQueueReceipt(item.value),
    ...(tree.value
      ? {
          worktree: {
            id: tree.value.intent.id,
            operationId: tree.value.operationId,
            phase: tree.value.phase,
            path: tree.value.intent.checkoutPath,
          },
        }
      : {}),
  });
}
