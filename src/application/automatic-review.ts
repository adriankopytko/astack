import { isDeepStrictEqual } from 'node:util';
import {
  reviewAutomationReadSchema,
  reviewAutomationSetSchema,
  followUpEnqueueSchema,
  followUpReadSchema,
  followUpControlSchema,
  followUpListRequestSchema,
  followUpPlanSchema,
  type FollowUpPlan,
} from '../contracts/automatic-review.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { AutomaticReviewStore } from '../ports/automatic-review.js';
import type { ReviewDependencies } from './review.js';
import { submitFollowUpReview } from './review.js';
import { inspectOwnedAssignment, OwnedAssignmentFailure } from './owned-assignment.js';
import { watchCi, type CiDependencies } from './ci.js';
import { configurationDigest } from '../core/configuration.js';
import { followUpCiRequest, followUpCiId } from '../core/automatic-review.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
export interface AutomaticReviewDependencies {
  executorEnabled: boolean;
  store: AutomaticReviewStore;
  reviews: ReviewDependencies;
  ci: CiDependencies;
  now: () => number;
  wake: () => void;
  wakeCi: () => void;
}
class AutomaticFailure extends Error {}
function take<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new AutomaticFailure();
  }

  return result.value;
}

function failure(error: unknown) {
  return error instanceof OwnedAssignmentFailure
    ? error.result
    : rejected(
        'automatic_review_blocked',
        'Automatic review requires unchanged source, trusted policy, controls and a dedicated clean owned checkout.',
      );
}

async function approved(
  projectId: string,
  repositoryId: string,
  deps: AutomaticReviewDependencies,
  signal?: AbortSignal,
) {
  const value = hostConfigurationPolicySchema.safeParse(
    await deps.reviews.configuration.readPolicy(projectId, signal),
  );

  if (
    !value.success ||
    value.data.projectId !== projectId ||
    value.data.repositoryId !== repositoryId ||
    !value.data.execution.enabled
  ) {
    throw new AutomaticFailure();
  }

  return value.data;
}

async function validate(
  plan: FollowUpPlan,
  deps: AutomaticReviewDependencies,
  signal?: AbortSignal,
) {
  const handoff = take(deps.ci.handoffs.find(plan.request.jobId, plan.request.handoffKey));
  const followUp = handoff?.record.followUpReview;

  if (
    !handoff ||
    handoff.record.id !== plan.handoffId ||
    handoff.record.phase !== 'accepted' ||
    followUp?.id !== plan.followUpId ||
    !isDeepStrictEqual(followUp.target, plan.target) ||
    !isDeepStrictEqual(followUp.gate, plan.gate) ||
    !isDeepStrictEqual(followUp.instructionPaths, plan.instructionPaths)
  ) {
    throw new AutomaticFailure();
  }

  const policy = await approved(plan.projectId, plan.repositoryId, deps, signal);

  if (
    configurationDigest(policy) !== plan.policyDigest ||
    (plan.gate.overrideReason !== null && policy.execution.review?.allowGateOverride !== true) ||
    (plan.gate.allowNoChecks === true && policy.execution.review?.allowNoChecks !== true)
  ) {
    throw new AutomaticFailure();
  }

  const owned = await inspectOwnedAssignment(
    {
      projectId: plan.projectId,
      checkoutId: plan.request.checkoutId,
      branch: plan.request.branch,
      commit: plan.target.sha,
    },
    deps.reviews,
    signal,
  );

  if (owned.root !== plan.root || owned.managed.intent.id !== plan.worktreeId) {
    throw new AutomaticFailure();
  }
}

export function inspectReviewAutomation(
  input: unknown,
  deps: Pick<AutomaticReviewDependencies, 'store'>,
) {
  const parsed = parseOperationRequest(reviewAutomationReadSchema, input);

  return parsed.valid ? deps.store.settings(parsed.value.projectId) : parsed.result;
}

export async function configureReviewAutomation(
  input: unknown,
  deps: AutomaticReviewDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(reviewAutomationSetSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    if (parsed.value.enabled) {
      const project = take(await deps.reviews.registry.readProject(parsed.value.projectId));

      if (!project) {
        throw new AutomaticFailure();
      }

      await approved(parsed.value.projectId, project.repository.id, deps, signal);
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Automation control cancelled.');
    }

    return deps.store.configure({ ...parsed.value, now: deps.now() });
  } catch (error) {
    return failure(error);
  }
}

export async function enqueueFollowUpReview(
  input: unknown,
  deps: AutomaticReviewDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(followUpEnqueueSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const request = parsed.value;
    const handoff = take(deps.ci.handoffs.find(request.jobId, request.handoffKey));
    const followUp = handoff?.record.followUpReview;

    if (
      !handoff ||
      handoff.record.phase !== 'accepted' ||
      !followUp ||
      request.commit !== followUp.target.sha ||
      request.checkoutId === handoff.record.source.checkoutId
    ) {
      throw new AutomaticFailure();
    }

    const id = `follow-up-plan-${configurationDigest(followUp.id)}`;
    const old = take(deps.store.find(id));

    if (old) {
      return isDeepStrictEqual(old.request, request)
        ? {
            schemaVersion: 1 as const,
            outcome: 'persisted' as const,
            disposition: 'existing' as const,
            value: old,
          }
        : rejected(
            'state_conflict',
            'This follow-up already has a different immutable checkout binding.',
          );
    }

    const owned = await inspectOwnedAssignment(
      {
        projectId: handoff.record.source.projectId,
        checkoutId: request.checkoutId,
        branch: request.branch,
        commit: request.commit,
      },
      deps.reviews,
      signal,
    );
    const settings = take(deps.store.settings(handoff.record.source.projectId));
    const policy = await approved(
      handoff.record.source.projectId,
      handoff.record.source.repositoryId,
      deps,
      signal,
    );
    const base = { id, request, ciGeneration: 0 };
    const now = deps.now();
    const plan = followUpPlanSchema.parse({
      schemaVersion: 1,
      ...base,
      projectId: handoff.record.source.projectId,
      repositoryId: handoff.record.source.repositoryId,
      handoffId: handoff.record.id,
      followUpId: followUp.id,
      target: followUp.target,
      gate: followUp.gate,
      instructionPaths: followUp.instructionPaths,
      worktreeId: owned.managed.intent.id,
      root: owned.root,
      policyDigest: configurationDigest(policy),
      phase: settings.enabled && deps.executorEnabled ? 'waiting' : 'suspended',
      reason: !deps.executorEnabled
        ? 'executor_disabled'
        : settings.enabled
          ? null
          : 'automation_disabled',
      revision: 0,
      automationRevision: settings.revision,
      ciId: followUpCiId(base),
      reviewKey: `after-handoff-${configurationDigest(id)}`,
      reviewJobId: null,
      createdAt: now,
      updatedAt: now,
    });
    await validate(plan, deps, signal);

    if (signal?.aborted) {
      return rejected('cancelled', 'Follow-up enrollment cancelled.');
    }

    return deps.store.reserve(plan);
  } catch (error) {
    return failure(error);
  }
}

export function inspectFollowUpReview(
  input: unknown,
  deps: Pick<AutomaticReviewDependencies, 'store'>,
) {
  const parsed = parseOperationRequest(followUpReadSchema, input);

  return parsed.valid ? deps.store.find(parsed.value.id) : parsed.result;
}

export function listFollowUpReviews(
  input: unknown,
  deps: Pick<AutomaticReviewDependencies, 'store'>,
) {
  const parsed = parseOperationRequest(followUpListRequestSchema, input);

  return parsed.valid ? deps.store.list(parsed.value) : parsed.result;
}

export async function controlFollowUpReview(
  input: unknown,
  deps: AutomaticReviewDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(followUpControlSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const plan = take(deps.store.find(parsed.value.id));

    if (!plan) {
      return rejected('follow_up_not_found', 'Follow-up not found.');
    }

    if (parsed.value.action === 'resume' && !deps.executorEnabled) {
      return rejected(
        'automatic_review_blocked',
        'The follow-up executor is disabled in this host.',
      );
    }

    if (parsed.value.action === 'resume') {
      await validate(plan, deps, signal);
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Follow-up control cancelled.');
    }

    return deps.store.control({
      ...parsed.value,
      reason: parsed.value.action === 'resume' ? null : `host_${parsed.value.action}`,
      now: deps.now(),
    });
  } catch (error) {
    return failure(error);
  }
}

/** One bounded pass; queue acceptance and linking are atomic, native launch remains the existing coordinator's responsibility. */
export async function dispatchFollowUpReviews(
  deps: AutomaticReviewDependencies,
  after = '',
  signal?: AbortSignal,
) {
  try {
    const page = take(deps.store.list({ after, limit: 32, activeOnly: true }));
    let processed = 0;

    for (const plan of page.items) {
      if (signal?.aborted) {
        break;
      }

      if (plan.phase === 'queued') {
        continue;
      }

      const settings = take(deps.store.settings(plan.projectId));

      if (!settings.enabled || settings.revision !== plan.automationRevision) {
        const changed = deps.store.control({
          id: plan.id,
          expectedRevision: plan.revision,
          action: 'suspend',
          reason: 'automation_changed',
          now: deps.now(),
        });

        if (
          changed.outcome !== 'persisted' &&
          !(changed.outcome === 'rejected' && changed.error.code === 'state_conflict')
        ) {
          return changed;
        }

        continue;
      }

      try {
        await validate(plan, deps, signal);
      } catch (error) {
        if (signal?.aborted) {
          break;
        }

        const blocked = deps.store.control({
          id: plan.id,
          expectedRevision: plan.revision,
          action: 'block',
          reason:
            error instanceof OwnedAssignmentFailure
              ? error.result.error.code
              : 'source_or_policy_changed',
          now: deps.now(),
        });

        if (
          blocked.outcome !== 'persisted' &&
          !(blocked.outcome === 'rejected' && blocked.error.code === 'state_conflict')
        ) {
          return blocked;
        }

        continue;
      }

      const enrolled = await watchCi(followUpCiRequest(plan), deps.ci, signal);

      if (enrolled.outcome === 'uncertain') {
        return enrolled;
      }

      if (enrolled.outcome === 'rejected') {
        const blocked = deps.store.control({
          id: plan.id,
          expectedRevision: plan.revision,
          action: 'block',
          reason: enrolled.error.code,
          now: deps.now(),
        });

        if (
          blocked.outcome !== 'persisted' &&
          !(blocked.outcome === 'rejected' && blocked.error.code === 'state_conflict')
        ) {
          return blocked;
        }

        continue;
      }

      if (enrolled.disposition === 'created') {
        deps.wakeCi();
      }

      const ci = enrolled.value.record;

      if (ci.phase === 'watching') {
        continue;
      }

      if (ci.phase !== 'ready') {
        const blocked = deps.store.control({
          id: plan.id,
          expectedRevision: plan.revision,
          action: 'block',
          reason: `ci_${ci.phase}`,
          now: deps.now(),
        });

        if (
          blocked.outcome !== 'persisted' &&
          !(blocked.outcome === 'rejected' && blocked.error.code === 'state_conflict')
        ) {
          return blocked;
        }

        continue;
      }

      if (signal?.aborted) {
        break;
      }

      const result = plan.reviewJobId
        ? deps.store.activate({ id: plan.id, expectedRevision: plan.revision, now: deps.now() })
        : await submitFollowUpReview(
            {
              schemaVersion: 1,
              projectId: plan.projectId,
              checkoutId: plan.request.checkoutId,
              key: plan.reviewKey,
              branch: plan.request.branch,
              commit: plan.target.sha,
              target: plan.target,
              gate: plan.gate,
              instructionPaths: plan.instructionPaths,
              repeat: false,
              resources: [],
              request: {},
            },
            deps.reviews,
            { planId: plan.id, followUpId: plan.followUpId },
            signal,
          );

      if (result.outcome === 'uncertain') {
        return result;
      }

      if (result.outcome === 'rejected') {
        const blocked = deps.store.control({
          id: plan.id,
          expectedRevision: plan.revision,
          action: 'block',
          reason: result.error.code,
          now: deps.now(),
        });

        if (
          blocked.outcome !== 'persisted' &&
          !(blocked.outcome === 'rejected' && blocked.error.code === 'state_conflict')
        ) {
          return blocked;
        }
      } else {
        deps.wake();
      }

      processed++;
    }

    return completed({ processed, nextCursor: page.nextCursor });
  } catch (error) {
    return failure(error);
  }
}

export function createFollowUpDispatcher(deps: AutomaticReviewDependencies, onFailure: () => void) {
  const controller = new AbortController();
  let stopped = false;
  let requested = false;
  let running: Promise<void> | null = null;
  function wake() {
    if (stopped) {
      return;
    }

    requested = true;

    if (running) {
      return;
    }

    running = (async () => {
      do {
        requested = false;
        let after = '';

        do {
          const result = await dispatchFollowUpReviews(deps, after, controller.signal);

          if (result.outcome !== 'completed') {
            if (!controller.signal.aborted) {
              stopped = true;
              onFailure();
            }

            return;
          }

          after = result.value.nextCursor ?? '';
        } while (after && !stopped && !controller.signal.aborted);
      } while (requested && !stopped && !controller.signal.aborted);
    })().finally(() => {
      running = null;
    });
  }

  return {
    wake,
    start: wake,
    async stop() {
      stopped = true;
      controller.abort();
      await running;
    },
  };
}

/** A host started without the executor suspends eligible backlog; restoring the flag never resumes it. */
export async function suspendFollowUpExecutor(store: AutomaticReviewStore, now: () => number) {
  let after = '';

  do {
    const page = store.list({ after, limit: 32, activeOnly: true });

    if (page.outcome === 'rejected') {
      return page;
    }

    for (const plan of page.value.items) {
      const result = store.control({
        id: plan.id,
        expectedRevision: plan.revision,
        action: 'suspend',
        reason: 'executor_disabled',
        now: now(),
      });

      if (result.outcome !== 'persisted') {
        return result;
      }
    }

    after = page.value.nextCursor ?? '';
  } while (after);

  return completed(null);
}
