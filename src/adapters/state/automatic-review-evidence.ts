import { isDeepStrictEqual } from 'node:util';
import {
  followUpPlanSchema,
  reviewAutomationSchema,
  type FollowUpPlan,
} from '../../contracts/automatic-review.js';
import { reviewTaskSchema, type ReviewTask } from '../../contracts/review-task.js';
import { stateJobSchema, type StateJob } from '../../contracts/state.js';
import { handoffRecordSchema } from '../../contracts/handoff.js';
import { ciRecordSchema, type CiRecord } from '../../contracts/ci.js';
import { reviewGateBlocker } from '../../core/review-gates.js';
import { configurationDigest } from '../../core/configuration.js';
import { followUpCiId } from '../../core/automatic-review.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { appendRunEvent } from './run-events.js';

function eventSource(db: StateDatabase, plan: FollowUpPlan) {
  const row = db
    .statement(
      'SELECT jobs.project_id,service_entries.attempt_id FROM jobs JOIN service_entries ON service_entries.job_id=jobs.id WHERE jobs.id=?',
    )
    .get(plan.request.jobId);

  if (row?.project_id !== plan.projectId || typeof row.attempt_id !== 'string') {
    stateFailure('state_invalid_data');
  }

  return {
    job: { id: plan.request.jobId, projectId: plan.projectId },
    attempt: { id: row.attempt_id },
  };
}

export function automationSettings(db: StateDatabase, projectId: string) {
  return (
    db.get(
      reviewAutomationSchema,
      'SELECT data FROM review_automation WHERE project_id=?',
      projectId,
    ) ?? { projectId, enabled: false, revision: 0, updatedAt: 0 }
  );
}

export function readFollowUp(db: StateDatabase, id: string) {
  const plan = db.get(followUpPlanSchema, 'SELECT data FROM review_follow_ups WHERE id=?', id);

  if (
    plan &&
    (plan.id !== `follow-up-plan-${configurationDigest(plan.followUpId)}` ||
      plan.ciId !== followUpCiId(plan))
  ) {
    stateFailure('state_invalid_data');
  }

  return plan;
}

export function saveFollowUp(
  db: StateDatabase,
  plan: FollowUpPlan,
  kind: 'follow_up_queued' | 'follow_up_controlled' | 'follow_up_dispatched',
) {
  const value = followUpPlanSchema.parse(plan);
  db.statement('UPDATE review_follow_ups SET phase=?,data=? WHERE id=?').run(
    value.phase,
    canonicalJson(value),
    value.id,
  );
  appendRunEvent(db, eventSource(db, value), kind, value.updatedAt, {
    planId: value.id,
    followUpId: value.followUpId,
    phase: value.phase,
    reason: value.reason,
    revision: value.revision,
    reviewJobId: value.reviewJobId,
  });
}

export function followUpSource(db: StateDatabase, plan: FollowUpPlan) {
  const handoff = db.get(
    handoffRecordSchema,
    'SELECT data FROM implementation_handoffs WHERE id=?',
    plan.handoffId,
  );
  const followUp = handoff?.followUpReview;

  if (
    !handoff ||
    handoff.phase !== 'accepted' ||
    handoff.request.jobId !== plan.request.jobId ||
    !followUp ||
    followUp.id !== plan.followUpId ||
    handoff.source.projectId !== plan.projectId ||
    handoff.source.repositoryId !== plan.repositoryId ||
    !isDeepStrictEqual(followUp.target, plan.target) ||
    !isDeepStrictEqual(followUp.gate, plan.gate) ||
    !isDeepStrictEqual(followUp.instructionPaths, plan.instructionPaths)
  ) {
    stateFailure('automatic_review_blocked');
  }
}

export function followUpReady(db: StateDatabase, plan: FollowUpPlan) {
  followUpSource(db, plan);
  const settings = automationSettings(db, plan.projectId);
  const ci = db.get(ciRecordSchema, 'SELECT data FROM ci_requests WHERE id=?', plan.ciId);

  return (
    settings.enabled &&
    settings.revision === plan.automationRevision &&
    ci?.phase === 'ready' &&
    ci.request.automaticReviewPlanId === plan.id &&
    ci.binding.projectId === plan.projectId &&
    ci.binding.sourceId === plan.followUpId &&
    ci.binding.policyDigest === plan.policyDigest &&
    isDeepStrictEqual(ci.binding.target, plan.target) &&
    isDeepStrictEqual(ci.binding.gate, plan.gate)
  );
}

export function automaticReviewAllowed(db: StateDatabase, jobId: string) {
  const job =
    db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', jobId) ??
    stateFailure('state_not_found');
  const task = reviewTaskSchema.safeParse(job.intent.task);

  if (!task.success || task.data.authorization !== 'after-handoff') {
    return true;
  }

  const plan = readFollowUp(db, task.data.followUp!.planId);

  return (
    !!plan &&
    plan.reviewJobId === job.id &&
    ['queued', 'dispatched'].includes(plan.phase) &&
    plan.followUpId === task.data.followUp!.followUpId &&
    plan.projectId === job.projectId &&
    plan.repositoryId === job.repositoryId &&
    plan.policyDigest === job.configuration?.policyDigest &&
    task.data.root === plan.root &&
    task.data.worktreeId === plan.worktreeId &&
    task.data.submission.key === plan.reviewKey &&
    task.data.submission.branch === plan.request.branch &&
    task.data.submission.commit === plan.target.sha &&
    isDeepStrictEqual(task.data.submission.target, plan.target) &&
    isDeepStrictEqual(task.data.submission.gate, plan.gate) &&
    isDeepStrictEqual(task.data.submission.instructionPaths, plan.instructionPaths) &&
    plan.request.checkoutId === job.checkoutId &&
    followUpReady(db, plan)
  );
}

export function assertFollowUpSubmission(db: StateDatabase, task: ReviewTask, job: StateJob) {
  if (task.authorization !== 'after-handoff') {
    return;
  }

  const plan = readFollowUp(db, task.followUp!.planId);

  if (
    !plan ||
    !['waiting', 'queued'].includes(plan.phase) ||
    !followUpReady(db, plan) ||
    plan.followUpId !== task.followUp!.followUpId ||
    plan.projectId !== job.projectId ||
    plan.repositoryId !== job.repositoryId ||
    plan.request.checkoutId !== job.checkoutId ||
    plan.request.branch !== task.submission.branch ||
    plan.request.commit !== task.submission.commit ||
    plan.reviewKey !== task.submission.key ||
    plan.root !== task.root ||
    plan.worktreeId !== task.worktreeId ||
    plan.policyDigest !== job.configuration?.policyDigest ||
    !isDeepStrictEqual(plan.target, task.submission.target) ||
    !isDeepStrictEqual(plan.gate, task.submission.gate) ||
    !isDeepStrictEqual(plan.instructionPaths, task.submission.instructionPaths) ||
    task.submission.repeat ||
    task.submission.resources.length ||
    Object.keys(task.submission.request).length ||
    reviewGateBlocker(task.initialSnapshot, plan.gate) !== null
  ) {
    stateFailure('automatic_review_blocked');
  }
}

export function linkFollowUpJob(db: StateDatabase, task: ReviewTask, job: StateJob, now: number) {
  if (task.authorization !== 'after-handoff') {
    return;
  }

  const plan = readFollowUp(db, task.followUp!.planId) ?? stateFailure('automatic_review_blocked');

  if (job.configuration?.policyDigest !== plan.policyDigest) {
    stateFailure('automatic_review_blocked');
  }

  const assigned = reviewTaskSchema.parse(job.intent.task);
  const owned = assigned.authorization === 'after-handoff' && assigned.followUp?.planId === plan.id;

  if (plan.reviewJobId && plan.reviewJobId !== job.id) {
    stateFailure('state_conflict');
  }

  saveFollowUp(
    db,
    {
      ...plan,
      phase: owned ? 'queued' : 'satisfied',
      reviewJobId: job.id,
      reason: owned ? null : 'existing_compatible_review',
      revision: plan.revision + 1,
      updatedAt: now,
    },
    'follow_up_queued',
  );
}

export function pauseFollowUpCi(db: StateDatabase, plan: FollowUpPlan, now: number) {
  const ci = db.get(ciRecordSchema, 'SELECT data FROM ci_requests WHERE id=?', plan.ciId);

  if (!ci || ci.phase !== 'watching') {
    return;
  }

  if (
    ci.request.automaticReviewPlanId !== plan.id ||
    ci.binding.sourceId !== plan.followUpId ||
    ci.binding.projectId !== plan.projectId
  ) {
    stateFailure('state_invalid_data');
  }

  const paused = ciRecordSchema.parse({
    ...ci,
    phase: 'suspended',
    reason: 'automatic_review_suspended',
    revision: ci.revision + 1,
    updatedAt: now,
  });
  db.statement('UPDATE ci_requests SET phase=?,data=? WHERE id=?').run(
    paused.phase,
    canonicalJson(paused),
    paused.id,
  );
  appendRunEvent(db, eventSource(db, plan), 'ci_controlled', now, {
    requestId: ci.id,
    phase: paused.phase,
    revision: paused.revision,
    reason: paused.reason,
  });
}

export function markAutomaticDispatch(db: StateDatabase, jobId: string, now: number) {
  const job =
    db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', jobId) ??
    stateFailure('state_not_found');
  const task = reviewTaskSchema.safeParse(job.intent.task);

  if (!task.success || task.data.authorization !== 'after-handoff') {
    return;
  }

  const plan =
    readFollowUp(db, task.data.followUp!.planId) ?? stateFailure('automatic_review_blocked');

  if (plan.phase !== 'queued' || !automaticReviewAllowed(db, jobId)) {
    stateFailure('automatic_review_blocked');
  }

  saveFollowUp(
    db,
    { ...plan, phase: 'dispatched', revision: plan.revision + 1, updatedAt: now },
    'follow_up_dispatched',
  );
}

export function assertAutomaticCi(db: StateDatabase, planId: string, ciId: string) {
  const plan = readFollowUp(db, planId) ?? stateFailure('automatic_review_blocked');
  const settings = automationSettings(db, plan.projectId);

  if (
    plan.phase !== 'waiting' ||
    plan.ciId !== ciId ||
    !settings.enabled ||
    settings.revision !== plan.automationRevision
  ) {
    stateFailure('automatic_review_blocked');
  }

  followUpSource(db, plan);

  return plan;
}

export function assertAutomaticCiRecord(db: StateDatabase, ci: CiRecord) {
  if (!ci.request.automaticReviewPlanId) {
    return;
  }

  const plan = assertAutomaticCi(db, ci.request.automaticReviewPlanId, ci.id);

  if (
    plan.projectId !== ci.binding.projectId ||
    plan.followUpId !== ci.binding.sourceId ||
    plan.policyDigest !== ci.binding.policyDigest ||
    !isDeepStrictEqual(plan.target, ci.binding.target) ||
    !isDeepStrictEqual(plan.gate, ci.binding.gate)
  ) {
    stateFailure('automatic_review_blocked');
  }
}
