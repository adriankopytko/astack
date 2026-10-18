import type { RunReconcileRequest, RunReconciliation } from '../contracts/run-reconciliation.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type {
  RunView,
  AcceptedRunReport,
  RunResponseRequest,
  RunResponse,
  RunResume,
  RunResumeRequest,
  RunCancellation,
  RunCancelRequest,
  RunEventsRequest,
  RunEventPage,
  RunCursor,
  RunCursorRequest,
  RunEventScope,
  ArtifactReference,
} from '../contracts/runs.js';
export interface RunStore {
  reconciliation(jobId: string): OperationResult<RunReconciliation | null>;
  reconcile(input: RunReconciliation): StateWriteResult<RunView>;
  inspect(jobId: string): OperationResult<RunView | null>;
  report(jobId: string, key: string): OperationResult<AcceptedRunReport | null>;
  acceptReport(input: {
    report: AcceptedRunReport;
    expectedRevision: number;
  }): StateWriteResult<RunView>;
  readResponse(jobId: string, id: string): OperationResult<RunResponse | null>;
  response(input: RunResponseRequest): StateWriteResult<RunView>;
  beginResume(input: RunResumeRequest): StateWriteResult<{ run: RunView; resume: RunResume }>;
  resume(jobId: string, key: string): OperationResult<RunResume | null>;
  transitionResume(input: {
    jobId: string;
    key: string;
    expected: RunResume['state'];
    state: RunResume['state'];
    reason: string | null;
  }): StateWriteResult<RunView>;
  cancel(input: RunCancelRequest): StateWriteResult<RunView>;
  cancellation(jobId: string, key?: string): OperationResult<RunCancellation | null>;
  observeCancellation(input: {
    jobId: string;
    key: string;
    state: RunCancellation['interruptState'];
  }): StateWriteResult<RunView>;
  events(input: RunEventsRequest): OperationResult<RunEventPage>;
  cursor(input: RunEventScope & { consumer: string }): OperationResult<RunCursor>;
  checkpoint(input: RunCursorRequest): StateWriteResult<RunCursor>;
}
/** Reads only bounded regular files beneath the owned checkout and returns exact digest/size references, never bytes. */
export interface RunArtifactReader {
  inspect(
    input: { root: string; artifacts: ArtifactReference[] },
    signal?: AbortSignal,
  ): Promise<OperationResult<ArtifactReference[]>>;
}
/** Persist the attempt/key before interrupt effects; pending/acknowledged keys never resend. Verify owned native identity and current host policy. */
export interface RunWorkerControl {
  interrupt(
    input: { attemptId: string; key: string },
    signal?: AbortSignal,
  ): Promise<OperationResult<{ state: 'acknowledged' | 'blocked' | 'unknown' }>>;
}
export interface RunEventWaiter {
  pause(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Reads a provider's typed final response for one explicit owned assignment. Output is still untrusted. */
export interface RunReportReader {
  read(
    input: { run: RunView; prompt: string },
    signal?: AbortSignal,
  ): Promise<OperationResult<unknown>>;
}

/** Host must stop coordinator writers before checking; absence is supplemented by explicit shutdown attestation. */
export interface RunShutdownVerifier {
  verify(
    input: { run: RunView; request: RunReconcileRequest },
    signal?: AbortSignal,
  ): Promise<OperationResult<RunReconciliation>>;
}
