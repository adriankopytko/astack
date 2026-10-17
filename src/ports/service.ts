import type { ReviewRequestLookup } from './review.js';
import type { OperationResult, OperationError } from '../contracts/operation-result.js';
import type { StateJob, StateWriteResult } from '../contracts/state.js';
import type {
  ServiceJob,
  ServiceEntry,
  ServiceLimits,
  WorkerObservation,
} from '../contracts/service.js';

export interface ServiceStore extends ReviewRequestLookup {
  submit(input: { job: StateJob; entry: ServiceEntry }): StateWriteResult<ServiceJob>;
  find(input: { projectId: string; role: string; key: string }): OperationResult<ServiceJob | null>;
  read(jobId: string): OperationResult<ServiceJob | null>;
  list(after?: string): OperationResult<{ items: ServiceJob[]; nextCursor: string | null }>;
  claim(input: {
    jobId: string;
    owner: string;
    token: string;
    now: number;
    limits: ServiceLimits;
  }): StateWriteResult<ServiceJob | null>;
  block(
    jobId: string,
    reason: NonNullable<ServiceEntry['reason']>,
    readiness?: OperationError,
  ): StateWriteResult<ServiceJob>;
  observe(jobId: string, observation: WorkerObservation, now: number): StateWriteResult<ServiceJob>;
}

/** Injected trusted adapter. Never infer launch absence from a missing process or expired claim. */
export interface ServiceWorkerRuntime {
  id: string;
  workflows?: readonly string[];
  /** Read-only workflow prerequisites, checked before capacity claim or provider launch. */
  preflight?(job: ServiceJob, signal: AbortSignal): Promise<OperationResult<{ ready: true }>>;
  start(job: ServiceJob, signal: AbortSignal): Promise<WorkerObservation>;
  inspect(job: ServiceJob, signal: AbortSignal): Promise<WorkerObservation>;
  subscribe?(wake: () => void): () => void;
}

/** Held by the host for the entire coordinator lifetime, independent of state transactions. */
export interface CoordinatorOwnership {
  release(): void;
}
