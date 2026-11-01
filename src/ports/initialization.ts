import type { OperationResult } from '../contracts/operation-result.js';
/** Inspect and prepare the selected initialization directory layout. */
export interface InitializationFiles {
  directory(root: string, anchor?: string): Promise<OperationResult<'missing' | 'present'>>;
  prepare(
    root: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<OperationResult<null>>;
}
