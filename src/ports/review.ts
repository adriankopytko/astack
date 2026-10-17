import type {
  ReviewSnapshot,
  ReviewTarget,
  ReviewSubmitRequest,
} from '../contracts/review-task.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { ServiceJob } from '../contracts/service.js';
/** Targeted reads only; a completed result must bracket checks with an unchanged full PR head. */
export interface ReviewTargetReader {
  read(
    input: { target: ReviewTarget; root: string },
    signal?: AbortSignal,
  ): Promise<OperationResult<ReviewSnapshot>>;
}
export interface ReviewRequestLookup {
  reviewRequest(input: {
    projectId: string;
    key: string;
  }): OperationResult<{ job: ServiceJob; submission: ReviewSubmitRequest } | null>;
}
