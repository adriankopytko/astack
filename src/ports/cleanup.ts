import type { CleanupPlan } from '../contracts/cleanup.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
export interface CleanupStore {
  read(jobId: string): OperationResult<CleanupPlan | null>;
  reserve(plan: CleanupPlan): StateWriteResult<CleanupPlan>;
  /** Claims never expire. A started plan requires explicit writer-excluded reconciliation. */
  transition(input: {
    jobId: string;
    expectedRevision: number;
    phase: CleanupPlan['phase'];
    reason: string | null;
    now: number;
    reconciliation?: true;
  }): StateWriteResult<CleanupPlan>;
  /** Rechecks frozen assignment, publication and terminal run state without provider effects. */
  authorize(plan: CleanupPlan): OperationResult<null>;
  list(input: {
    after: string;
    limit: number;
  }): OperationResult<{ items: CleanupPlan[]; nextCursor: string | null }>;
}
