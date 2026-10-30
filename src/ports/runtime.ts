import type { HostConfigurationPolicy } from '../contracts/configuration.js';
import type { HerdrSpace } from '../contracts/herdr.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { RuntimeSession, RuntimeAction, RuntimeInputRetry } from '../contracts/runtime.js';

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
  checkHookPrerequisites?(jobId: string): OperationResult<null>;
  checkAutomaticReview?(jobId: string): OperationResult<null>;
  read(attemptId: string): OperationResult<RuntimeSession | null>;
  reserve(session: RuntimeSession): StateWriteResult<RuntimeSession>;
  validate(previous: RuntimeSession, next: RuntimeSession): StateWriteResult<RuntimeSession>;
  bind(previous: RuntimeSession, next: RuntimeSession): StateWriteResult<RuntimeSession>;
  action(attemptId: string, key: string): OperationResult<RuntimeAction | null>;
  pending(attemptId: string): OperationResult<RuntimeAction | null>;
  reserveAction(session: RuntimeSession, action: RuntimeAction): StateWriteResult<RuntimeAction>;
  acknowledge(action: RuntimeAction): StateWriteResult<RuntimeAction>;
  inputRetry(
    attemptId: string,
    key: string,
    generation: number,
  ): OperationResult<RuntimeInputRetry | null>;
  authorizeInputRetry(
    session: RuntimeSession,
    action: RuntimeAction,
  ): StateWriteResult<RuntimeInputRetry>;
}

/** Provider-specific validation, never a worker execution or sandbox-enforcement receipt. */
export interface RuntimeLaunchValidator {
  validate(
    input: RuntimeLaunchValidationInput,
    signal?: AbortSignal,
  ): Promise<
    OperationResult<{
      args: string[];
      contextDigest: string;
    }>
  >;
  inspect(
    input: RuntimeLaunchValidationInput,
    signal?: AbortSignal,
  ): Promise<OperationResult<{ contextDigest: string; args: string[] }>>;
}
export interface RuntimeLaunchValidationInput {
  profile: NonNullable<HostConfigurationPolicy['execution']['launchProfiles']>[string];
  executable: string;
  args: string[];
  space: HerdrSpace;
  invocationId: string;
  timeoutMs: number;
}
/** Runs a bounded validator in the selected empty owned pane; returns output only after a unique successful shell-exit receipt. */
export interface RuntimePaneProbe {
  probe(
    input: {
      space: HerdrSpace;
      executable: string;
      program: string;
      marker: string;
      timeoutMs: number;
    },
    signal?: AbortSignal,
  ): Promise<OperationResult<string>>;
}
