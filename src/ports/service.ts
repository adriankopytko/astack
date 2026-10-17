import type { OperationResult } from '../contracts/operation-result.js';
import type { StateJob, StateWriteResult } from '../contracts/state.js';
import type {
  ServiceJob,
  ServiceEntry,
  ServiceLimits,
  WorkerObservation,
} from '../contracts/service.js';

export interface ServiceStore {
  submit(input: { job: StateJob; entry: ServiceEntry }): StateWriteResult<ServiceJob>;
  read(jobId: string): OperationResult<ServiceJob | null>;
  list(after?: string): OperationResult<{ items: ServiceJob[]; nextCursor: string | null }>;
  claim(input: {
    jobId: string;
    owner: string;
    token: string;
    now: number;
    limits: ServiceLimits;
  }): StateWriteResult<ServiceJob | null>;
  block(jobId: string, reason: NonNullable<ServiceEntry['reason']>): StateWriteResult<ServiceJob>;
  observe(jobId: string, observation: WorkerObservation, now: number): StateWriteResult<ServiceJob>;
}

/** Injected trusted adapter. Never infer launch absence from a missing process or expired claim. */
export interface ServiceWorkerRuntime {
  id: string;
  start(job: ServiceJob, signal: AbortSignal): Promise<WorkerObservation>;
  inspect(job: ServiceJob, signal: AbortSignal): Promise<WorkerObservation>;
  subscribe?(wake: () => void): () => void;
}

/** Held by the host for the entire coordinator lifetime, independent of state transactions. */
export interface CoordinatorOwnership {
  release(): void;
}
