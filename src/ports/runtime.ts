import type { HerdrSpace } from '../contracts/herdr.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { RuntimeSession, RuntimeAction } from '../contracts/runtime.js';

/** Herdr owns the interactive process. Astack never starts a second process controller. */
export interface InteractiveWorkerProvider {
  launch(
    input: { space: HerdrSpace; args: string[]; timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<OperationResult<null>>;
  input(space: HerdrSpace, text: string, signal?: AbortSignal): Promise<OperationResult<null>>;
  interrupt(space: HerdrSpace, signal?: AbortSignal): Promise<OperationResult<null>>;
}
export interface RuntimeStore {
  read(attemptId: string): OperationResult<RuntimeSession | null>;
  reserve(session: RuntimeSession): StateWriteResult<RuntimeSession>;
  bind(previous: RuntimeSession, next: RuntimeSession): StateWriteResult<RuntimeSession>;
  action(attemptId: string, key: string): OperationResult<RuntimeAction | null>;
  pending(attemptId: string): OperationResult<RuntimeAction | null>;
  reserveAction(session: RuntimeSession, action: RuntimeAction): StateWriteResult<RuntimeAction>;
  acknowledge(action: RuntimeAction): StateWriteResult<RuntimeAction>;
}
