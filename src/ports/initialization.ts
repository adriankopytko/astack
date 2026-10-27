import type { OperationResult } from '../contracts/operation-result.js';
import type { InitializationSignals } from '../contracts/initialization.js';
/** Bounded read-only project signals and known directory layout; never execute detected project code. */
export interface InitializationFiles {
  directory(
    root: string,
    privateRoot?: boolean,
    anchor?: string,
  ): Promise<OperationResult<'missing' | 'present'>>;
  signals(root: string): Promise<OperationResult<InitializationSignals>>;
  prepare(
    root: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<OperationResult<null>>;
}
