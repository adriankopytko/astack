import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { ReviewAutomation, FollowUpPlan } from '../contracts/automatic-review.js';
export interface AutomaticReviewStore {
  settings(projectId: string): OperationResult<ReviewAutomation>;
  configure(input: {
    projectId: string;
    enabled: boolean;
    expectedRevision: number;
    now: number;
  }): StateWriteResult<ReviewAutomation>;
  find(id: string): OperationResult<FollowUpPlan | null>;
  reserve(plan: FollowUpPlan): StateWriteResult<FollowUpPlan>;
  list(input: {
    projectId?: string;
    after: string;
    limit: number;
    activeOnly?: boolean;
  }): OperationResult<{ items: FollowUpPlan[]; nextCursor: string | null }>;
  control(input: {
    id: string;
    expectedRevision: number;
    action: 'suspend' | 'resume' | 'cancel' | 'block';
    reason: string | null;
    now: number;
  }): StateWriteResult<FollowUpPlan>;
  activate(input: {
    id: string;
    expectedRevision: number;
    now: number;
  }): StateWriteResult<FollowUpPlan>;
  /** Read-only gate for new automatic dispatch/initial input, never for inspecting an already running worker. */
  authorize(jobId: string): OperationResult<null>;
  authorizeCi(planId: string, ciId: string): OperationResult<null>;
}
