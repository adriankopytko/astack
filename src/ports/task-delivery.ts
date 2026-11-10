import type { OperationResult } from '../contracts/operation-result.js';
import type { InstructionReference } from '../contracts/task-context.js';
import type { WorkerInputReceipt, WorkerInputObservation } from '../contracts/task-delivery.js';

/** Read scoped repository Markdown bytes without executing or exporting their contents. */
export interface TaskContextReader {
  read(
    input: { root: string; paths: string[] },
    signal?: AbortSignal,
  ): Promise<OperationResult<InstructionReference[]>>;
}

/** Persist keys and digests before input and never replay pending or acknowledged writes. */
export interface WorkerInput {
  receipt(input: { attemptId: string; key: string }): OperationResult<WorkerInputReceipt | null>;
  submit(
    input: { attemptId: string; key: string; text: string },
    signal?: AbortSignal,
  ): Promise<OperationResult<WorkerInputObservation>>;
}
