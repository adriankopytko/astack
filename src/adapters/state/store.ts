import { z } from 'zod';
import { checkoutRecordSchema, projectRecordSchema } from '../../contracts/project-context.js';
import {
  stateAttemptSchema,
  stateClaimSchema,
  stateEffectIntentSchema,
  stateEffectSchema,
  stateJobSchema,
  stateRecordSchema,
  stateRepositorySchema,
  stateResourceIntentSchema,
  stateResourceSchema,
  stateResultSchema,
  type StateEffect,
  type StateJob,
  type StateRecord,
  type StateResource,
} from '../../contracts/state.js';
import { sha256 } from '../../core/file-paths.js';
import type { StateStore } from '../../ports/state-store.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { StateError, stateFailure } from './errors.js';

function valid<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    return stateFailure('state_invalid_data');
  }

  return parsed.data;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 32_768) {
    return stateFailure('state_invalid_data');
  }

  try {
    return JSON.parse(value);
  } catch {
    return stateFailure('state_invalid_data');
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fingerprint(job: StateJob): string {
  return sha256(
    canonicalJson({
      projectId: job.projectId,
      repositoryId: job.repositoryId,
      checkoutId: job.checkoutId,
      requester: job.requester,
      operation: job.operation,
      idempotencyKey: job.idempotencyKey,
      intent: job.intent,
      ...(job.configuration === undefined ? {} : { configuration: job.configuration }),
    }),
  );
}

export function createStateStore(db: StateDatabase, clock: () => number): StateStore {
  const now = () => {
    const value = clock();

    if (!Number.isSafeInteger(value) || value < 0) {
      return stateFailure('state_unavailable');
    }

    return value;
  };

  const readEffect = (id: string): StateEffect | null => {
    const row = db.statement('SELECT * FROM effects WHERE id=?').get(id);

    if (!row) {
      return null;
    }

    return valid(stateEffectSchema, {
      intent: db.data(stateEffectIntentSchema, row),
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
      evidence: row.evidence === null ? null : json(row.evidence),
    });
  };

  const requiredEffect = (id: string) => readEffect(id) ?? stateFailure('state_not_found');
  const readResource = (id: string): StateResource | null => {
    const row = db.statement('SELECT * FROM resources WHERE id=?').get(id);

    if (!row) {
      return null;
    }

    return valid(stateResourceSchema, {
      intent: db.data(stateResourceIntentSchema, row),
      releasedAt: row.released_at,
      releaseEvidence: row.release_evidence === null ? null : json(row.release_evidence),
    });
  };

  return {
    saveProject(request) {
      return db.write(() => {
        const repository = db.get(
          stateRepositorySchema,
          'SELECT data FROM repositories WHERE id=?',
          request.repository.id,
        );
        const project = db.get(
          projectRecordSchema,
          'SELECT data FROM projects WHERE id=?',
          request.project.id,
        );
        const checkout = db.get(
          checkoutRecordSchema,
          'SELECT data FROM checkouts WHERE id=?',
          request.checkout.id,
        );

        if (
          (repository && !same(repository, request.repository)) ||
          (project && !same(project, request.project)) ||
          (checkout && !same(checkout, request.checkout))
        ) {
          stateFailure('state_conflict');
        }

        if (!repository) {
          db.statement('INSERT INTO repositories(id, common_directory, data) VALUES (?, ?, ?)').run(
            request.repository.id,
            request.repository.commonDirectory,
            canonicalJson(request.repository),
          );
        }

        if (!project) {
          db.statement('INSERT INTO projects(id, primary_checkout_id, data) VALUES (?, ?, ?)').run(
            request.project.id,
            request.project.primaryCheckoutId,
            canonicalJson(request.project),
          );
        }

        if (!checkout) {
          db.statement(
            'INSERT INTO checkouts(id, project_id, repository_id, root_path, data) VALUES (?, ?, ?, ?, ?)',
          ).run(
            request.checkout.id,
            request.checkout.projectId,
            request.checkout.repositoryId,
            request.checkout.rootPath,
            canonicalJson(request.checkout),
          );
        }

        return {
          value: request,
          disposition: repository && project && checkout ? 'existing' : 'created',
        };
      });
    },
    acceptJob({ job }) {
      return db.write(() => {
        const row = db
          .statement(
            'SELECT data, intent_hash FROM jobs WHERE requester=? AND project_id=? AND operation=? AND idempotency_key=?',
          )
          .get(job.requester, job.projectId, job.operation, job.idempotencyKey);
        const existing = db.data(stateJobSchema, row);

        if (existing) {
          if (row?.intent_hash !== fingerprint(existing)) {
            stateFailure('state_invalid_data');
          }

          if (fingerprint(existing) !== fingerprint(job)) {
            stateFailure('state_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        db.statement(
          'INSERT INTO jobs(id, project_id, repository_id, checkout_id, requester, operation, idempotency_key, intent_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          job.id,
          job.projectId,
          job.repositoryId,
          job.checkoutId,
          job.requester,
          job.operation,
          job.idempotencyKey,
          fingerprint(job),
          canonicalJson(job),
        );

        return { value: job, disposition: 'created' };
      });
    },
    prepareAttempt({ attempt, effects }) {
      return db.write(() => {
        const existing = db.get(
          stateAttemptSchema,
          'SELECT data FROM attempts WHERE id=?',
          attempt.id,
        );

        if (existing) {
          const saved = db
            .statement('SELECT id FROM effects WHERE attempt_id=? ORDER BY id LIMIT 17')
            .all(attempt.id)
            .map((row) => requiredEffect(valid(z.string(), row.id)));
          const requested = [...effects].sort((left, right) =>
            left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
          );

          if (
            !same(existing, attempt) ||
            !same(
              saved.map((effect) => effect.intent),
              requested,
            )
          ) {
            stateFailure('state_conflict');
          }

          return { value: { attempt: existing, effects: saved }, disposition: 'existing' };
        }

        const repository = db.get(
          stateRepositorySchema,
          'SELECT repositories.data FROM repositories JOIN jobs ON jobs.repository_id=repositories.id WHERE jobs.id=?',
          attempt.jobId,
        );

        if (!repository) {
          stateFailure('state_not_found');
        }

        if (attempt.commit.length !== (repository.objectFormat === 'sha1' ? 40 : 64)) {
          stateFailure('state_conflict');
        }

        if (
          db
            .statement('SELECT id FROM attempts WHERE job_id=? AND resolved_at IS NULL LIMIT 1')
            .get(attempt.jobId)
        ) {
          stateFailure('state_reconciliation_required');
        }

        const last = db
          .statement('SELECT COALESCE(MAX(number), 0) AS number FROM attempts WHERE job_id=?')
          .get(attempt.jobId)?.number;

        if (typeof last !== 'number' || attempt.number !== last + 1) {
          stateFailure('state_conflict');
        }

        db.statement('INSERT INTO attempts(id, job_id, number, data) VALUES (?, ?, ?, ?)').run(
          attempt.id,
          attempt.jobId,
          attempt.number,
          canonicalJson(attempt),
        );

        for (const effect of effects) {
          db.statement(
            "INSERT INTO effects(id, attempt_id, kind, effect_key, state, data) VALUES (?, ?, ?, ?, 'pending', ?)",
          ).run(effect.id, effect.attemptId, effect.kind, effect.key, canonicalJson(effect));
        }

        return {
          value: {
            attempt,
            effects: effects.map((intent) => ({
              intent,
              state: 'pending' as const,
              claim: null,
              evidence: null,
            })),
          },
          disposition: 'created',
        };
      });
    },
    claimEffect(request) {
      return db.write(() => {
        const effect = requiredEffect(request.effectId);
        const time = now();

        if (
          effect.state === 'unknown' ||
          (effect.claim && (effect.claim.expiresAt <= time || effect.claim.claimedAt > time))
        ) {
          stateFailure('state_reconciliation_required');
        }

        if (effect.state !== 'pending') {
          stateFailure('state_conflict');
        }

        if (effect.claim) {
          if (effect.claim.owner !== request.owner || effect.claim.token !== request.token) {
            stateFailure('state_conflict');
          }

          return { value: effect, disposition: 'existing' };
        }

        const claim = valid(stateClaimSchema, {
          owner: request.owner,
          token: request.token,
          claimedAt: time,
          expiresAt: time + request.leaseMs,
        });
        db.statement(
          'UPDATE effects SET claim_owner=?, claim_token=?, claimed_at=?, expires_at=? WHERE id=?',
        ).run(claim.owner, claim.token, claim.claimedAt, claim.expiresAt, request.effectId);

        return { value: { ...effect, claim }, disposition: 'updated' };
      });
    },
    resolveEffect(request) {
      return db.write(() => {
        const effect = requiredEffect(request.effectId);

        if (
          !effect.claim ||
          effect.claim.owner !== request.owner ||
          effect.claim.token !== request.token
        ) {
          stateFailure('state_conflict');
        }

        if (effect.state === request.state && same(effect.evidence, request.evidence)) {
          return { value: effect, disposition: 'existing' };
        }

        if (effect.state !== 'pending' && effect.state !== 'unknown') {
          stateFailure('state_conflict');
        }

        db.statement('UPDATE effects SET state=?, evidence=? WHERE id=?').run(
          request.state,
          canonicalJson(request.evidence),
          request.effectId,
        );

        return {
          value: { ...effect, state: request.state, evidence: request.evidence },
          disposition: 'updated',
        };
      });
    },
    recordResult({ result }) {
      return db.write(() => {
        const existing = db.get(
          stateResultSchema,
          'SELECT data FROM results WHERE attempt_id=?',
          result.attemptId,
        );

        if (existing) {
          if (!same(existing, result)) {
            stateFailure('state_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        if (!db.statement('SELECT id FROM attempts WHERE id=?').get(result.attemptId)) {
          stateFailure('state_not_found');
        }

        if (
          db
            .statement(
              "SELECT id FROM effects WHERE attempt_id=? AND state IN ('pending', 'unknown') LIMIT 1",
            )
            .get(result.attemptId)
        ) {
          stateFailure('state_reconciliation_required');
        }

        db.statement('INSERT INTO results(id, attempt_id, data) VALUES (?, ?, ?)').run(
          result.id,
          result.attemptId,
          canonicalJson(result),
        );
        db.statement('UPDATE attempts SET resolved_at=? WHERE id=?').run(
          result.createdAt,
          result.attemptId,
        );

        return { value: result, disposition: 'created' };
      });
    },
    retainResource({ resource }) {
      return db.write(() => {
        const existing = readResource(resource.id);

        if (existing) {
          if (!same(existing.intent, resource)) {
            stateFailure('state_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        db.statement(
          'INSERT INTO resources(id, attempt_id, kind, resource_key, data) VALUES (?, ?, ?, ?, ?)',
        ).run(
          resource.id,
          resource.attemptId,
          resource.kind,
          resource.key,
          canonicalJson(resource),
        );

        return {
          value: { intent: resource, releasedAt: null, releaseEvidence: null },
          disposition: 'created',
        };
      });
    },
    releaseResource(request) {
      return db.write(() => {
        const resource = readResource(request.resourceId) ?? stateFailure('state_not_found');

        if (resource.intent.attemptId !== request.attemptId) {
          stateFailure('state_conflict');
        }

        if (resource.releasedAt !== null) {
          if (!same(resource.releaseEvidence, request.evidence)) {
            stateFailure('state_conflict');
          }

          return { value: resource, disposition: 'existing' };
        }

        const releasedAt = now();
        db.statement('UPDATE resources SET released_at=?, release_evidence=? WHERE id=?').run(
          releasedAt,
          canonicalJson(request.evidence),
          request.resourceId,
        );

        return {
          value: { ...resource, releasedAt, releaseEvidence: request.evidence },
          disposition: 'updated',
        };
      });
    },
    inspectRecord({ entity, id }) {
      return db.read<StateRecord | null>(() => {
        switch (entity) {
          case 'job': {
            const record = db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', id);

            return record ? { entity, record } : null;
          }

          case 'attempt': {
            const row = db.statement('SELECT data, resolved_at FROM attempts WHERE id=?').get(id);

            return row
              ? valid(stateRecordSchema, {
                  entity,
                  record: db.data(stateAttemptSchema, row),
                  resolvedAt: row.resolved_at,
                })
              : null;
          }

          case 'effect': {
            const record = readEffect(id);

            return record ? { entity, record } : null;
          }

          case 'result': {
            const record = db.get(stateResultSchema, 'SELECT data FROM results WHERE id=?', id);

            return record ? { entity, record } : null;
          }

          case 'resource': {
            const record = readResource(id);

            return record ? { entity, record } : null;
          }
        }
      });
    },
    async readProject(id, signal) {
      if (signal?.aborted) {
        throw new StateError('cancelled');
      }

      const result = db.read(() =>
        db.get(projectRecordSchema, 'SELECT data FROM projects WHERE id=?', id),
      );

      if (result.outcome === 'rejected') {
        throw new StateError(result.error.code);
      }

      return result.value;
    },
    async readCheckout(id, signal) {
      if (signal?.aborted) {
        throw new StateError('cancelled');
      }

      const result = db.read(() =>
        db.get(checkoutRecordSchema, 'SELECT data FROM checkouts WHERE id=?', id),
      );

      if (result.outcome === 'rejected') {
        throw new StateError(result.error.code);
      }

      return result.value;
    },
    close: () => db.close(),
  };
}
