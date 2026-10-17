import {
  serviceEntrySchema,
  serviceJobSchema,
  workerObservationSchema,
  type ServiceEntry,
  type ServiceJob,
} from '../../contracts/service.js';
import {
  stateJobSchema,
  stateAttemptSchema,
  stateEffectSchema,
  stateClaimSchema,
  stateResourceIntentSchema,
} from '../../contracts/state.js';
import type { ServiceStore } from '../../ports/service.js';
import { reviewTaskSchema, reviewSubmitRequestSchema } from '../../contracts/review-task.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { acceptJobTransaction } from './store.js';
import { stateFailure } from './errors.js';

export function createSqliteServiceStore(db: StateDatabase): ServiceStore {
  function read(id: string): ServiceJob | null {
    const entry = db.get(serviceEntrySchema, 'SELECT data FROM service_entries WHERE job_id=?', id);

    if (!entry) {
      return null;
    }

    const job = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', id);
    const attempt = db.get(
      stateAttemptSchema,
      'SELECT data FROM attempts WHERE id=?',
      entry.attemptId,
    );
    const row = db
      .statement('SELECT data, state, evidence FROM effects WHERE id=?')
      .get(entry.effectId);
    const parsed = serviceJobSchema.safeParse({
      job,
      entry,
      attempt,
      effect: row
        ? {
            intent: db.data(stateEffectSchema.shape.intent, row),
            state: row.state,
            claim: entry.claim,
            evidence: row.evidence === null ? null : (JSON.parse(String(row.evidence)) as unknown),
          }
        : null,
    });

    if (!parsed.success) {
      stateFailure('state_invalid_data');
    }

    return parsed.data;
  }

  function required(id: string): ServiceJob {
    return read(id) ?? stateFailure('state_not_found');
  }

  function update(entry: ServiceEntry): ServiceJob {
    const valid = serviceEntrySchema.safeParse(entry);

    if (!valid.success) {
      stateFailure('state_invalid_data');
    }

    db.statement('UPDATE service_entries SET state=?, data=? WHERE job_id=?').run(
      entry.state,
      canonicalJson(entry),
      entry.jobId,
    );

    return required(entry.jobId);
  }

  return {
    submit({ job, entry }) {
      return db.write(() => {
        const review = reviewTaskSchema.safeParse(job.intent.task);

        if (
          review.success &&
          (entry.role !== 'reviewer' ||
            job.operation !== 'delegate:reviewer' ||
            review.data.submission.projectId !== job.projectId ||
            review.data.submission.checkoutId !== job.checkoutId ||
            review.data.submission.key !== job.idempotencyKey ||
            review.data.submission.branch !== entry.branch ||
            review.data.submission.commit !== entry.commit)
        ) {
          stateFailure('state_conflict');
        }

        if (review.success) {
          const submission = review.data.submission;
          const alias = db
            .statement(
              'SELECT job_id, submission FROM review_requests WHERE project_id=? AND request_key=?',
            )
            .get(job.projectId, submission.key);

          if (alias) {
            if (String(alias.submission) !== canonicalJson(submission)) {
              stateFailure('state_conflict');
            }

            return { value: required(String(alias.job_id)), disposition: 'existing' };
          }

          if (!submission.repeat) {
            const target = submission.target;
            const existing = db
              .statement(`SELECT id FROM jobs WHERE project_id=? AND repository_id=? AND operation='delegate:reviewer'
              AND json_extract(data, '$.intent.task.workflow')='review'
              AND json_extract(data, '$.intent.task.submission.target.host')=?
              AND json_extract(data, '$.intent.task.submission.target.repository')=?
              AND json_extract(data, '$.intent.task.submission.target.number')=?
              AND json_extract(data, '$.intent.task.submission.target.sha')=? ORDER BY json_extract(data, '$.createdAt') DESC, id DESC LIMIT 1`)
              .get(
                job.projectId,
                job.repositoryId,
                target.host,
                target.repository,
                target.number,
                target.sha,
              );

            if (existing) {
              const saved = required(String(existing.id));
              const task = reviewTaskSchema.parse(saved.job.intent.task);

              if (
                canonicalJson(task.submission.gate) !== canonicalJson(submission.gate) ||
                canonicalJson(task.submission.resources) !== canonicalJson(submission.resources) ||
                canonicalJson(task.submission.request) !== canonicalJson(submission.request) ||
                canonicalJson(task.submission.instructionPaths) !==
                  canonicalJson(submission.instructionPaths)
              ) {
                stateFailure('state_conflict');
              }

              db.statement(
                'INSERT INTO review_requests(project_id, request_key, job_id, submission) VALUES (?,?,?,?)',
              ).run(job.projectId, submission.key, saved.job.id, canonicalJson(submission));

              return { value: saved, disposition: 'existing' };
            }
          }
        }

        // A review checkout is dedicated across its lifetime, including unresolved/quiescent work.
        const prior = db
          .statement('SELECT data FROM jobs WHERE checkout_id=? AND id<>?')
          .all(job.checkoutId, job.id);

        for (const row of prior) {
          const previous = stateJobSchema.parse(JSON.parse(String(row.data)));
          const previousReview = reviewTaskSchema.safeParse(previous.intent.task).success;

          if (review.success || previousReview) {
            stateFailure('state_conflict');
          }
        }

        const accepted = acceptJobTransaction(db, job);

        if (accepted.disposition === 'existing') {
          const existing = required(accepted.value.id);

          if (
            existing.entry.branch !== entry.branch ||
            existing.entry.commit !== entry.commit ||
            existing.entry.role !== entry.role
          ) {
            stateFailure('state_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        const repository = db
          .statement('SELECT data FROM repositories WHERE id=?')
          .get(job.repositoryId);
        const format = repository
          ? (JSON.parse(String(repository.data)) as { objectFormat?: unknown })
          : null;

        if (entry.commit.length !== (format?.objectFormat === 'sha256' ? 64 : 40)) {
          stateFailure('state_conflict');
        }

        const attempt = stateAttemptSchema.parse({
          id: entry.attemptId,
          jobId: job.id,
          number: 1,
          branch: entry.branch,
          commit: entry.commit,
          createdAt: job.createdAt,
        });
        const effect = stateEffectSchema.shape.intent.parse({
          id: entry.effectId,
          attemptId: attempt.id,
          kind: 'worker-launch',
          key: 'initial',
          createdAt: job.createdAt,
          payload: { runtime: job.configuration?.effective.roles[entry.role]?.runtime ?? null },
        });
        const parsed = serviceJobSchema.safeParse({
          job,
          entry,
          attempt,
          effect: { intent: effect, state: 'pending', claim: null, evidence: null },
        });

        if (
          !parsed.success ||
          entry.state !== 'queued' ||
          entry.claim !== null ||
          entry.observation !== null ||
          entry.reason !== null
        ) {
          stateFailure('state_conflict');
        }

        db.statement('INSERT INTO attempts(id, job_id, number, data) VALUES (?, ?, 1, ?)').run(
          attempt.id,
          job.id,
          canonicalJson(attempt),
        );
        db.statement(
          "INSERT INTO effects(id, attempt_id, kind, effect_key, state, data) VALUES (?, ?, 'worker-launch', 'initial', 'pending', ?)",
        ).run(effect.id, attempt.id, canonicalJson(effect));
        db.statement(
          'INSERT INTO service_entries(job_id, queued_at, attempt_id, effect_id, role, state, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          job.id,
          job.createdAt,
          attempt.id,
          effect.id,
          entry.role,
          entry.state,
          canonicalJson(entry),
        );

        if (review.success) {
          db.statement(
            'INSERT INTO review_requests(project_id, request_key, job_id, submission) VALUES (?,?,?,?)',
          ).run(
            job.projectId,
            review.data.submission.key,
            job.id,
            canonicalJson(review.data.submission),
          );
        }

        return { value: required(job.id), disposition: 'created' };
      });
    },
    find: ({ projectId, role, key }) =>
      db.read(() => {
        const row = db
          .statement(
            'SELECT id FROM jobs WHERE requester=? AND project_id=? AND operation=? AND idempotency_key=?',
          )
          .get('local-host', projectId, `delegate:${role}`, key);

        return row ? required(String(row.id)) : null;
      }),
    reviewRequest: ({ projectId, key }) =>
      db.read(() => {
        const row = db
          .statement(
            'SELECT job_id, submission FROM review_requests WHERE project_id=? AND request_key=?',
          )
          .get(projectId, key);

        if (!row) {
          return null;
        }

        const job = required(String(row.job_id));
        const submission = reviewSubmitRequestSchema.parse(JSON.parse(String(row.submission)));
        const task = reviewTaskSchema.parse(job.job.intent.task);

        if (
          submission.projectId !== projectId ||
          submission.key !== key ||
          job.job.projectId !== projectId ||
          canonicalJson(submission.target) !== canonicalJson(task.submission.target)
        ) {
          stateFailure('state_invalid_data');
        }

        return { job, submission };
      }),
    read: (id) => db.read(() => read(id)),
    list(after) {
      return db.read(() => {
        const cursor =
          after === undefined
            ? null
            : db.statement('SELECT queued_at FROM service_entries WHERE job_id=?').get(after);

        if (after !== undefined && !cursor) {
          stateFailure('state_not_found');
        }

        const rows = db
          .statement(
            'SELECT job_id FROM service_entries WHERE queued_at>? OR (queued_at=? AND job_id>?) ORDER BY queued_at, job_id LIMIT 101',
          )
          .all(
            cursor ? Number(cursor.queued_at) : -1,
            cursor ? Number(cursor.queued_at) : -1,
            after ?? '',
          );
        const ids = rows.slice(0, 100).map((row) => String(row.job_id));

        return {
          items: ids.map(required),
          nextCursor: rows.length > 100 ? (ids.at(-1) ?? null) : null,
        };
      });
    },
    claim({ jobId, owner, token, now, limits }) {
      return db.write<ServiceJob | null>(() => {
        const current = required(jobId);

        if (current.entry.claim !== null || !['queued', 'blocked'].includes(current.entry.state)) {
          return { value: null, disposition: 'existing' };
        }

        const counts = db
          .statement(
            "SELECT role, COUNT(*) AS count FROM service_entries WHERE state IN ('dispatching', 'started', 'unknown') GROUP BY role",
          )
          .all();
        const competing = db
          .statement(
            "SELECT service_entries.job_id FROM service_entries JOIN jobs ON jobs.id=service_entries.job_id WHERE service_entries.state IN ('dispatching', 'started', 'unknown') AND (jobs.checkout_id=? OR (jobs.repository_id=? AND json_extract(service_entries.data, '$.branch')=?)) LIMIT 1",
          )
          .get(current.job.checkoutId, current.job.repositoryId, current.entry.branch);

        if (competing) {
          return { value: null, disposition: 'existing' };
        }

        let total = 0;
        let role = 0;

        for (const row of counts) {
          if (typeof row.count !== 'number') {
            stateFailure('state_invalid_data');
          }

          total += row.count;

          if (row.role === current.entry.role) {
            role = row.count;
          }
        }

        const roleLimit = Object.hasOwn(limits.perRole, current.entry.role)
          ? (limits.perRole[current.entry.role] ?? limits.defaultRole)
          : limits.defaultRole;

        if (total >= limits.global || role >= roleLimit) {
          return { value: null, disposition: 'existing' };
        }

        const claim = stateClaimSchema.parse({
          owner,
          token,
          claimedAt: now,
          expiresAt: now + 10_000,
        });
        const changed = db
          .statement(
            "UPDATE effects SET claim_owner=?, claim_token=?, claimed_at=?, expires_at=? WHERE id=? AND state='pending' AND claim_token IS NULL",
          )
          .run(owner, token, now, claim.expiresAt, current.entry.effectId);

        if (changed.changes !== 1) {
          stateFailure('state_reconciliation_required');
        }

        return {
          value: update({
            ...current.entry,
            state: 'dispatching',
            reason: null,
            readiness: null,
            claim,
          }),
          disposition: 'updated',
        };
      });
    },
    block(jobId, reason, readiness) {
      return db.write(() => {
        const current = required(jobId);

        if (current.entry.claim !== null) {
          stateFailure('state_conflict');
        }

        return {
          value: update({
            ...current.entry,
            state: 'blocked',
            reason,
            readiness: readiness ?? null,
          }),
          disposition: 'updated',
        };
      });
    },
    observe(jobId, input, now) {
      return db.write(() => {
        const observation = workerObservationSchema.parse(input);
        const current = required(jobId);

        if (
          !current.entry.claim ||
          current.entry.state === 'awaiting_result' ||
          (current.effect.state === 'confirmed' && observation.state === 'not_started') ||
          (current.effect.state === 'cancelled' && observation.state !== 'not_started')
        ) {
          stateFailure('state_conflict');
        }

        const resourceId = `worker:${current.entry.attemptId}`;
        const resource = db
          .statement('SELECT data, released_at FROM resources WHERE id=?')
          .get(resourceId);

        if (resource && observation.state === 'not_started') {
          stateFailure('state_conflict');
        }

        if (observation.state === 'unknown' && observation.handle === null) {
          observation.handle = current.entry.observation?.handle ?? null;
        }

        if (observation.handle !== null) {
          if (resource) {
            const previous = JSON.parse(String(resource.data)) as { handle?: unknown };

            if (
              canonicalJson(previous.handle) !== canonicalJson(observation.handle) ||
              resource.released_at !== null
            ) {
              stateFailure('state_conflict');
            }
          } else {
            const intent = stateResourceIntentSchema.parse({
              id: resourceId,
              attemptId: current.entry.attemptId,
              kind: 'worker',
              key: current.entry.attemptId,
              createdAt: now,
              handle: observation.handle,
            });
            db.statement(
              "INSERT INTO resources(id, attempt_id, kind, resource_key, data) VALUES (?, ?, 'worker', ?, ?)",
            ).run(
              resourceId,
              current.entry.attemptId,
              current.entry.attemptId,
              canonicalJson(intent),
            );
          }
        }

        if (current.effect.state === 'pending' || current.effect.state === 'unknown') {
          const state =
            observation.state === 'unknown'
              ? 'unknown'
              : observation.state === 'not_started'
                ? 'cancelled'
                : 'confirmed';
          db.statement('UPDATE effects SET state=?, evidence=? WHERE id=?').run(
            state,
            canonicalJson(observation.evidence),
            current.entry.effectId,
          );
        }

        if (observation.state === 'quiescent') {
          db.statement(
            'UPDATE resources SET released_at=?, release_evidence=? WHERE id=? AND released_at IS NULL',
          ).run(now, canonicalJson(observation.evidence), resourceId);
        }

        return {
          value: update({
            ...current.entry,
            observation,
            state:
              observation.state === 'running'
                ? 'started'
                : observation.state === 'quiescent'
                  ? 'awaiting_result'
                  : observation.state === 'not_started'
                    ? 'blocked'
                    : 'unknown',
            reason:
              observation.state === 'unknown'
                ? 'provider_uncertain'
                : observation.state === 'not_started'
                  ? 'provider_refused'
                  : null,
          }),
          disposition: 'updated',
        };
      });
    },
  };
}
