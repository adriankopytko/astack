import type { OperationResult } from '../contracts/operation-result.js';
import type {
  StateAttempt,
  StateAttemptRequest,
  StateClaimRequest,
  StateEffect,
  StateEffectResolutionRequest,
  StateInspectionRequest,
  StateJob,
  StateJobRequest,
  StateProjectRequest,
  StateRecord,
  StateResource,
  StateResourceReleaseRequest,
  StateResourceRequest,
  StateResult,
  StateResultRequest,
  StateWriteResult,
} from '../contracts/state.js';
import type { ProjectContextReader } from './project-context-reader.js';

/** Synchronous, bounded local transactions only. No provider execution or transaction callbacks. */
export interface StateStore extends ProjectContextReader {
  saveProject(request: StateProjectRequest): StateWriteResult<StateProjectRequest>;
  acceptJob(request: StateJobRequest): StateWriteResult<StateJob>;
  prepareAttempt(
    request: StateAttemptRequest,
  ): StateWriteResult<{ attempt: StateAttempt; effects: StateEffect[] }>;
  claimEffect(request: StateClaimRequest): StateWriteResult<StateEffect>;
  resolveEffect(request: StateEffectResolutionRequest): StateWriteResult<StateEffect>;
  recordResult(request: StateResultRequest): StateWriteResult<StateResult>;
  retainResource(request: StateResourceRequest): StateWriteResult<StateResource>;
  releaseResource(request: StateResourceReleaseRequest): StateWriteResult<StateResource>;
  inspectRecord(request: StateInspectionRequest): OperationResult<StateRecord | null>;
  close(): OperationResult<{ closed: true }>;
}
