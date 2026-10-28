import type {
  AllocationRequest,
  AllocationRecord,
  PortEndpoint,
  AllocationStart,
  AllocationRelease,
  AllocationRunning,
} from '../contracts/resources.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
/** One shared host database, with synchronous short claims. No OS effects inside transactions. */
export interface AllocationStore {
  reserve(request: AllocationRequest): StateWriteResult<AllocationRecord>;
  inspect(id: string): OperationResult<AllocationRecord | null>;
  probe(input: {
    id: string;
    expectedRevision: number;
    observation: 'free' | 'busy' | 'unknown';
  }): StateWriteResult<AllocationRecord>;
  next(input: { id: string; expectedRevision: number }): StateWriteResult<AllocationRecord>;
  start(request: AllocationStart): StateWriteResult<AllocationRecord>;
  running(request: AllocationRunning): StateWriteResult<AllocationRecord>;
  retain(input: { id: string; expectedRevision: number }): StateWriteResult<AllocationRecord>;
  release(request: AllocationRelease): StateWriteResult<AllocationRecord>;
  list(input: {
    projectId?: string | undefined;
    after: string;
    limit: number;
  }): OperationResult<{ items: AllocationRecord[]; nextCursor: string | null }>;
}
/** Temporary exclusive bind probe, closed before return. Never proves listener ownership or shutdown. */
export interface PortProbe {
  inspect(
    endpoint: PortEndpoint,
    signal?: AbortSignal,
  ): Promise<OperationResult<'free' | 'busy' | 'unknown'>>;
}
