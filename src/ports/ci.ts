import type { CiRecord, CiTarget, CiView, CiPolicy } from '../contracts/ci.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { GithubResult } from '../contracts/github.js';
import type { ReviewSnapshot, ReviewTarget } from '../contracts/review-task.js';
export interface CiReader {
  /** Budget is a hard upper bound on attempted API subprocesses, including pages and bracketing reads. Honor cancellation and a bounded aggregate deadline. */
  read(
    input: { target: ReviewTarget; root: string; maxRequests: number },
    signal?: AbortSignal,
  ): Promise<GithubResult<ReviewSnapshot>>;
}
export interface CiStore {
  find(id: string): OperationResult<CiView | null>;
  reserve(record: CiRecord): StateWriteResult<CiView>;
  list(input: {
    projectId: string;
    after: string;
    limit: number;
  }): OperationResult<{ items: CiRecord[]; nextCursor: string | null }>;
  subscribers(targetId: string): OperationResult<CiRecord[]>;
  due(now: number, limit: number): OperationResult<CiTarget[]>;
  nextWake(): OperationResult<number | null>;
  expire(now: number): StateWriteResult<{ expired: number }>;
  control(input: {
    id: string;
    expectedRevision: number;
    phase: CiRecord['phase'];
    reason: string | null;
    now: number;
    deadlineAt?: number;
  }): StateWriteResult<CiView>;
  claim(input: {
    targetId: string;
    owner: string;
    token: string;
    now: number;
    policy: CiPolicy;
  }): StateWriteResult<CiTarget | null>;
  settle(input: {
    target: CiTarget;
    owner: string;
    token: string;
    now: number;
    retryNotBefore: number | null;
    decisions: { id: string; revision: number; phase: CiRecord['phase']; reason: string | null }[];
  }): StateWriteResult<CiTarget>;
}
