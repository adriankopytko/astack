import { configurationDigest } from './configuration.js';
import type { FollowUpPlan } from '../contracts/automatic-review.js';
export function followUpCiRequest(plan: Pick<FollowUpPlan, 'id' | 'request' | 'ciGeneration'>) {
  return {
    schemaVersion: 1 as const,
    automaticReviewPlanId: plan.id,
    source: {
      kind: 'handoff' as const,
      jobId: plan.request.jobId,
      ...(plan.request.handoffKey === undefined ? {} : { key: plan.request.handoffKey }),
    },
    key: `after-handoff-${configurationDigest({ planId: plan.id, generation: plan.ciGeneration })}`,
    timeoutMs: plan.request.timeoutMs,
  };
}

export function followUpCiId(plan: Pick<FollowUpPlan, 'id' | 'request' | 'ciGeneration'>) {
  const request = followUpCiRequest(plan);

  return `ci-${configurationDigest({ source: request.source, key: request.key })}`;
}
