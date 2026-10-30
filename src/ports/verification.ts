import type { VerificationRecord, VerificationReconcile } from '../contracts/verification.js';
import type { HandoffSource } from '../contracts/handoff.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
export interface VerificationStore {
  read(id: string): OperationResult<VerificationRecord | null>;
  prepare(record: VerificationRecord): StateWriteResult<VerificationRecord>;
  update(
    record: VerificationRecord,
    expectedRevision: number,
  ): StateWriteResult<VerificationRecord>;
  reconcile(request: VerificationReconcile): StateWriteResult<VerificationRecord>;
  /** Fresh local authority at the store clock, not a worker supplied passed claim. */
  authorize(
    id: string,
    source: HandoffSource,
    jobId: string,
    reportId: string,
  ): OperationResult<VerificationRecord>;
}
