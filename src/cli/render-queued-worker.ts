import type { WorkerQueueReceipt } from '../contracts/worker-queue.js';

export function renderQueuedWorker(value: WorkerQueueReceipt): string {
  const lines = [
    `Job: ${value.id}`,
    `Project: ${value.request.submission.projectId}`,
    `Agent: ${value.request.submission.agent ?? value.request.kind}`,
    `State: ${value.state}`,
  ];

  if (value.cancelRequested && value.state === 'preparing') {
    lines.push('Cancellation requested; waiting for preparation to settle.');
  }

  if (value.error) {
    lines.push(`Error: ${value.error.code}: ${value.error.message}`);
  }

  if (value.worktree) {
    lines.push(
      `Worktree: ${value.worktree.path} (${value.worktree.id}, operation ${value.worktree.operationId}, ${value.worktree.phase})`,
    );
  }

  return `${lines.join('\n')}\n`;
}
