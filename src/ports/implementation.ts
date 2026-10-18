import type { OperationResult } from '../contracts/operation-result.js';
import type {
  InstructionReference,
  ImplementationInputReceipt,
  ImplementationInputObservation,
} from '../contracts/implementation.js';

/** Read scoped repository Markdown bytes without executing instructions or exporting their contents. */
export interface ImplementationContextReader {
  read(
    input: { root: string; paths: string[] },
    signal?: AbortSignal,
  ): Promise<OperationResult<InstructionReference[]>>;
}
/** The provider MUST persist keys/digests before input, never replay pending or acknowledged writes, and bind the saved attempt. */
export interface ImplementationWorkerInput {
  receipt(input: {
    attemptId: string;
    key: string;
  }): OperationResult<ImplementationInputReceipt | null>;
  submit(
    input: { attemptId: string; key: string; text: string },
    signal?: AbortSignal,
  ): Promise<OperationResult<ImplementationInputObservation>>;
}
