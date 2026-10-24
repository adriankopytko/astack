import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';

import type { HandoffRecord, HandoffView, PushIntent, PushReceipt } from '../contracts/handoff.js';
export interface HandoffStore {
  find(jobId: string, key?: string): OperationResult<HandoffView | null>;
  reserve(record: HandoffRecord): StateWriteResult<HandoffView>;
  accept(input: {
    id: string;
    receipt: NonNullable<HandoffRecord['receipt']>;
    acceptedAt: number;
  }): StateWriteResult<HandoffView>;
  followUps(input: { projectId: string; after: string; limit: number }): OperationResult<{
    items: NonNullable<HandoffRecord['followUpReview']>[];
    nextCursor: string | null;
  }>;
}
/** Host-approved HTTPS destination only. No implicit remote aliases, automatic retry or branch cleanup. */
export interface GitPublisher {
  inspect(
    input: { root: string; intent: PushIntent },
    signal?: AbortSignal,
  ): Promise<OperationResult<PushReceipt | null>>;
  push(
    input: { root: string; intent: PushIntent },
    signal?: AbortSignal,
  ): Promise<
    | OperationResult<PushReceipt>
    | {
        schemaVersion: 1;
        outcome: 'uncertain';
        error: { code: 'git_write_uncertain'; message: string };
      }
  >;
}
