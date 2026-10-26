import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type {
  ReviewResultRead,
  ReviewResultObservation,
  ReviewResultPublication,
  ReviewResultPublicationView,
} from '../contracts/review-results.js';
export interface ReviewResultStore {
  observation(reportId: string): OperationResult<ReviewResultObservation | null>;
  observe(input: {
    source: ReviewResultRead;
    reportId: string;
    expectedRevision: number | null;
    observation: Omit<ReviewResultObservation, 'revision'>;
  }): StateWriteResult<ReviewResultObservation>;
  find(
    source: ReviewResultRead & { key: string },
  ): OperationResult<ReviewResultPublicationView | null>;
  complete(
    source: ReviewResultRead & { key: string },
  ): StateWriteResult<ReviewResultPublicationView>;
  reserve(record: ReviewResultPublication): StateWriteResult<ReviewResultPublicationView>;
}
