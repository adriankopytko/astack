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
import { canonicalJson, type StateDatabase } from './database.js';
import { acceptJobTransaction } from './store.js';
import { runControl, saveRunControl, appendRunEvent } from './run-events.js';
import { stateFailure } from './errors.js';
import { configurationDigest } from '../../core/configuration.js';
import { hostConfigurationPolicySchema } from '../../contracts/configuration.js';
import { appendServiceError } from './error-store.js';
import { workerQueueItemSchema } from '../../contracts/worker-queue.js';

export function createSqliteServiceStore(
  db: StateDatabase,
  now: () => number = Date.now,
): ServiceStore {
  function read(id: string): ServiceJob | null {
    const entry = db.get(serviceEntrySchema, 'SELECT data FROM service_entries WHERE job_id=?', id);

    if (!entry) {
      return null;
    }

    const control = runControl(db, id);

    if (control.revision > 0) {
      entry.control = control;
    }

    const job = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', id);
    const attempt = db.get(
      stateAttemptSchema,
      'SELECT data FROM attempts WHERE id=?',
      entry.attemptId,
    );
    const row = db.statement('SELECT * FROM effects WHERE id=?').get(entry.effectId);
    const parsed = serviceJobSchema.safeParse({
      job,
      entry,
      attempt,
      effect: row
        ? {
            intent: db.data(stateEffectSchema.shape.intent, row),
            state: row.state,
            claim:
              row.claim_token === null
                ? null
                : {
                    owner: row.claim_owner,
                    token: row.claim_token,
                    claimedAt: row.claimed_at,
                    expiresAt: row.expires_at,
                  },
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
    submit({ job, entry, policy }) {
      return db.write(() => {
        if (
          !hostConfigurationPolicySchema.safeParse(policy).success ||
          configurationDigest(policy) !== job.configuration?.policyDigest ||
          policy.projectId !== job.projectId ||
          policy.repositoryId !== job.repositoryId
        ) {
          stateFailure('state_conflict');
        }

        // Serialize new assignments against durable cleanup claims and worktree removal.
        // Existing idempotent submissions remain inspectable after cleanup.
        if (
          !db.statement('SELECT id FROM jobs WHERE id=?').get(job.id) &&
          (db
            .statement(
              "SELECT job_id FROM cleanup_plans WHERE checkout_id=? AND phase!='cancelled'",
            )
            .get(job.checkoutId) ||
            db
              .statement(
                "SELECT id FROM managed_worktrees WHERE json_extract(data,'$.intent.checkoutId')=? AND phase!='ready'",
              )
              .get(job.checkoutId))
        ) {
          stateFailure('state_conflict');
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

        db.statement('INSERT INTO job_configurations(job_id, data) VALUES (?, ?)').run(
          job.id,
          canonicalJson(policy),
        );

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

        const created = required(job.id);
        const request = db.get(
          workerQueueItemSchema,
          'SELECT data FROM worker_requests WHERE id=?',
          job.id,
        );

        if (request) {
          if (
            request.state !== 'preparing' ||
            request.cancelRequested ||
            request.request.submission.agent !== entry.role ||
            request.request.submission.projectId !== job.projectId ||
            request.request.submission.key !== job.idempotencyKey ||
            configurationDigest(request.policy) !== job.configuration?.policyDigest
          ) {
            stateFailure('state_conflict');
          }

          const prepared = { ...request, state: 'prepared' as const, jobId: job.id };
          db.statement('UPDATE worker_requests SET state=?,data=? WHERE id=?').run(
            prepared.state,
            canonicalJson(prepared),
            prepared.id,
          );
        }

        appendRunEvent(db, created, 'accepted', now(), { role: entry.role });

        return { value: created, disposition: 'created' };
      });
    },
    find: ({ projectId, role, key, workflow }) =>
      db.read(() => {
        const row = db
          .statement(
            'SELECT id FROM jobs WHERE requester=? AND project_id=? AND operation=? AND idempotency_key=?',
          )
          .get(
            'local-host',
            projectId,
            workflow === 'handoff' ? 'handoff' : `delegate:${role}`,
            key,
          );

        return row ? required(String(row.id)) : null;
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

        if (
          runControl(db, jobId).phase !== 'active' ||
          db.statement('SELECT id FROM results WHERE attempt_id=?').get(current.attempt.id) !==
            undefined ||
          current.entry.claim !== null ||
          current.effect.claim !== null ||
          current.effect.state !== 'pending' ||
          !['queued', 'blocked'].includes(current.entry.state)
        ) {
          return { value: null, disposition: 'existing' };
        }

        const counts = db
          .statement(
            "SELECT role, COUNT(*) AS count FROM service_entries WHERE state IN ('dispatching', 'started', 'unknown') GROUP BY role",
          )
          .all();
        const reservations = db
          .statement(
            "SELECT COALESCE(json_extract(data, '$.request.submission.agent'),kind) AS role,COUNT(*) AS count FROM worker_requests WHERE state IN ('preparing','prepared') AND id<>? GROUP BY role",
          )
          .all(jobId);
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

        for (const row of [...counts, ...reservations]) {
          if (typeof row.count !== 'number') {
            stateFailure('state_invalid_data');
          }

          total += row.count;

          if (row.role === current.entry.role) {
            role += row.count;
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

        const reservation = db.get(
          workerQueueItemSchema,
          'SELECT data FROM worker_requests WHERE id=?',
          jobId,
        );

        if (reservation && ['prepared', 'blocked'].includes(reservation.state)) {
          const started = { ...reservation, state: 'started' as const };
          db.statement('UPDATE worker_requests SET state=?,data=? WHERE id=?').run(
            started.state,
            canonicalJson(started),
            started.id,
          );
        }

        appendRunEvent(db, current, 'claimed', now, { owner });

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

        if (
          current.entry.reason !== reason ||
          canonicalJson(current.entry.readiness ?? null) !== canonicalJson(readiness ?? null)
        ) {
          appendRunEvent(db, current, 'blocked', now(), { reason, readiness: readiness ?? null });
          appendServiceError(
            db,
            {
              operation: 'worker_dispatch',
              projectId: current.job.projectId,
              jobId,
              code: readiness?.code ?? reason,
              message: (readiness?.message ?? `Worker blocked: ${reason}.`).slice(0, 2048),
            },
            now(),
          );

          const reservation = db.get(
            workerQueueItemSchema,
            'SELECT data FROM worker_requests WHERE id=?',
            jobId,
          );

          if (reservation?.state === 'prepared') {
            const blocked = {
              ...reservation,
              state: 'blocked' as const,
              error: {
                code: readiness?.code ?? reason,
                message: (readiness?.message ?? `Worker blocked: ${reason}.`).slice(0, 2048),
              },
            };
            db.statement('UPDATE worker_requests SET state=?,data=? WHERE id=?').run(
              blocked.state,
              canonicalJson(blocked),
              blocked.id,
            );
          }
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

        if (canonicalJson(current.entry.observation) !== canonicalJson(observation)) {
          appendRunEvent(db, current, 'observed', now, { state: observation.state });

          if (observation.state === 'unknown') {
            appendServiceError(
              db,
              {
                operation: 'worker_observation',
                projectId: current.job.projectId,
                jobId,
                code: 'provider_uncertain',
                message: 'Worker state is uncertain; inspect the run for details.',
              },
              now,
            );
          }
        }

        const control = runControl(db, jobId);

        if (
          control.phase === 'cancel_requested' &&
          ['quiescent', 'not_started'].includes(observation.state)
        ) {
          saveRunControl(db, jobId, {
            ...control,
            phase: 'cancelled',
            revision: control.revision + 1,
          });
          appendRunEvent(db, current, 'cancelled', now, { proof: observation.state });
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
