import { createHash } from 'node:crypto';

/** Keep this encoding stable: existing runtime action receipts use this exact fingerprint. */
export function workerInputDigest(kind: 'input' | 'interrupt', text: string): string {
  return createHash('sha256').update(JSON.stringify({ kind, text })).digest('hex');
}
