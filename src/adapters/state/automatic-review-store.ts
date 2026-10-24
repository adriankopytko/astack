import { isDeepStrictEqual } from 'node:util';
import {
  followUpPlanSchema,
  reviewAutomationSchema,
  type FollowUpPlan,
} from '../../contracts/automatic-review.js';
import type { AutomaticReviewStore } from '../../ports/automatic-review.js';
import { followUpCiId } from '../../core/automatic-review.js';
import { configurationDigest } from '../../core/configuration.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import {
  automationSettings,
  readFollowUp,
  saveFollowUp,
  followUpSource,
  followUpReady,
  automaticReviewAllowed,
  pauseFollowUpCi,
  assertAutomaticCi,
} from './automatic-review-evidence.js';

export function createSqliteAutomaticReviewStore(db: StateDatabase): AutomaticReviewStore {
  return {
    settings(projectId) {
      return db.read(() => automationSettings(db, projectId));
    },
    configure(input) {
      return db.write(() => {
        const old = automationSettings(db, input.projectId);

        if (old.revision !== input.expectedRevision) {
          stateFailure('state_conflict');
        }

        if (old.enabled === input.enabled) {
          return { value: old, disposition: 'existing' };
        }

        const settings = reviewAutomationSchema.parse({
          projectId: input.projectId,
          enabled: input.enabled,
          revision: old.revision + 1,
          updatedAt: input.now,
        });
        db.statement(
          'INSERT INTO review_automation(project_id,data) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data',
        ).run(input.projectId, canonicalJson(settings));

        if (!input.enabled) {
          const rows = db
            .statement(
              "SELECT data FROM review_follow_ups WHERE project_id=? AND phase IN ('waiting','queued','blocked') LIMIT 257",
            )
            .all(input.projectId);

          if (rows.length > 256) {
            stateFailure('state_invalid_data');
          }

          for (const row of rows) {
            const plan = followUpPlanSchema.parse(db.data(followUpPlanSchema, row));
            pauseFollowUpCi(db, plan, input.now);
            saveFollowUp(
              db,
              {
                ...plan,
                phase: 'suspended',
                reason: 'automation_disabled',
                revision: plan.revision + 1,
                updatedAt: input.now,
              },
              'follow_up_controlled',
            );
          }
        }

        return { value: settings, disposition: 'updated' };
      });
    },
    find(id) {
      return db.read(() => readFollowUp(db, id));
    },
    reserve(input) {
      return db.write(() => {
        const plan = followUpPlanSchema.parse(input);

        if (
          plan.id !== `follow-up-plan-${configurationDigest(plan.followUpId)}` ||
          plan.ciId !== followUpCiId(plan)
        ) {
          stateFailure('state_invalid_data');
        }

        const old = readFollowUp(db, plan.id);

        if (old) {
          if (!isDeepStrictEqual(old.request, plan.request)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        followUpSource(db, plan);
        const settings = automationSettings(db, plan.projectId);
        const count = db
          .statement(
            "SELECT COUNT(*) AS count FROM review_follow_ups WHERE project_id=? AND phase IN ('waiting','queued','blocked','suspended')",
          )
          .get(plan.projectId)?.count;

        if (
          typeof count !== 'number' ||
          count >= 256 ||
          plan.revision !== 0 ||
          plan.reviewJobId !== null ||
          plan.ciGeneration !== 0 ||
          plan.automationRevision !== settings.revision ||
          !['waiting', 'suspended'].includes(plan.phase) ||
          (plan.phase === 'waiting' && !settings.enabled)
        ) {
          stateFailure('automatic_review_blocked');
        }

        db.statement(
          'INSERT INTO review_follow_ups(id,project_id,follow_up_id,phase,data) VALUES (?,?,?,?,?)',
        ).run(plan.id, plan.projectId, plan.followUpId, plan.phase, canonicalJson(plan));
        saveFollowUp(db, plan, 'follow_up_controlled');

        return { value: plan, disposition: 'created' };
      });
    },
    list(input) {
      return db.read(() => {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
          stateFailure('invalid_request');
        }

        const rows = db
          .statement(
            "SELECT data FROM review_follow_ups WHERE id>? AND (? IS NULL OR project_id=?) AND (?=0 OR phase IN ('waiting','queued')) ORDER BY id LIMIT ?",
          )
          .all(
            input.after,
            input.projectId ?? null,
            input.projectId ?? null,
            input.activeOnly ? 1 : 0,
            input.limit + 1,
          );
        const items = rows
          .slice(0, input.limit)
          .map((row) => db.data(followUpPlanSchema, row) ?? stateFailure('state_invalid_data'));

        return { items, nextCursor: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null };
      });
    },
    control(input) {
      return db.write(() => {
        const plan = readFollowUp(db, input.id) ?? stateFailure('follow_up_not_found');

        if (plan.revision !== input.expectedRevision) {
          stateFailure('state_conflict');
        }

        if (['dispatched', 'satisfied', 'cancelled'].includes(plan.phase)) {
          stateFailure('automatic_review_blocked');
        }

        const settings = automationSettings(db, plan.projectId);

        if (input.action === 'resume' && !settings.enabled) {
          stateFailure('automatic_review_blocked');
        }

        pauseFollowUpCi(db, plan, input.now);
        const changed: FollowUpPlan = {
          ...plan,
          phase:
            input.action === 'resume'
              ? 'waiting'
              : input.action === 'cancel'
                ? 'cancelled'
                : input.action === 'suspend'
                  ? 'suspended'
                  : 'blocked',
          reason: input.reason,
          revision: plan.revision + 1,
          updatedAt: input.now,
          automationRevision: settings.revision,
          ciGeneration: plan.ciGeneration + (input.action === 'resume' ? 1 : 0),
        };
        changed.ciId = followUpCiId(changed);
        saveFollowUp(db, changed, 'follow_up_controlled');

        return { value: changed, disposition: 'updated' };
      });
    },
    activate(input) {
      return db.write(() => {
        const plan = readFollowUp(db, input.id) ?? stateFailure('follow_up_not_found');

        if (
          plan.revision !== input.expectedRevision ||
          plan.phase !== 'waiting' ||
          !plan.reviewJobId ||
          !followUpReady(db, plan)
        ) {
          stateFailure('automatic_review_blocked');
        }

        const changed: FollowUpPlan = {
          ...plan,
          phase: 'queued',
          reason: null,
          revision: plan.revision + 1,
          updatedAt: input.now,
        };
        saveFollowUp(db, changed, 'follow_up_queued');

        if (!automaticReviewAllowed(db, plan.reviewJobId)) {
          stateFailure('automatic_review_blocked');
        }

        return { value: changed, disposition: 'updated' };
      });
    },
    authorizeCi(planId, ciId) {
      return db.read(() => {
        assertAutomaticCi(db, planId, ciId);

        return null;
      });
    },
    authorize(jobId) {
      return db.read(() => {
        if (!automaticReviewAllowed(db, jobId)) {
          stateFailure('automatic_review_blocked');
        }

        return null;
      });
    },
  };
}
