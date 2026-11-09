import { sha256 } from './file-paths.js';
import type { WorkerQueueItem } from '../contracts/worker-queue.js';

/** Stable worktree identity, shared by submission and explicit recovery. */
export function workerWorktreeKey(
  kind: WorkerQueueItem['request']['kind'],
  submission: WorkerQueueItem['request']['submission'],
): string {
  const identity =
    kind === 'reviewer' && 'target' in submission && !submission.repeat
      ? `${submission.target.host}/${submission.target.repository}/${submission.target.number}/${submission.target.sha}`
      : submission.key;
  const digest = sha256(`${submission.projectId}\0${kind}\0${identity}`).slice(0, 32);

  return `worker-${kind}-${digest}`;
}
