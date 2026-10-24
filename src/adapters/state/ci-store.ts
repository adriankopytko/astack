import { assertAutomaticCiRecord } from './automatic-review-evidence.js';
import { configurationDigest } from '../../core/configuration.js';
import { isDeepStrictEqual } from 'node:util';
import {
  ciRecordSchema,
  ciTargetSchema,
  ciViewSchema,
  ciPolicySchema,
  type CiRecord,
  type CiTarget,
} from '../../contracts/ci.js';
import type { CiStore } from '../../ports/ci.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { createSqliteRunStore } from './run-store.js';
import { appendRunEvent } from './run-events.js';

export function createSqliteCiStore(db: StateDatabase, now: () => number): CiStore {
  const runs = createSqliteRunStore(db, now);
  function checkedRecord(record: CiRecord): CiRecord {
    if (
      record.id !==
        `ci-${configurationDigest({ source: record.request.source, key: record.request.key })}` ||
      record.targetId !== `ci-target-${configurationDigest(record.binding.target)}`
    ) {
      stateFailure('state_invalid_data');
    }

    return record;
  }

  function checkedTarget(value: CiTarget): CiTarget {
    if (value.id !== `ci-target-${configurationDigest(value.target)}`) {
      stateFailure('state_invalid_data');
    }

    return value;
  }

  const read = (id: string) => {
    const record = db.get(ciRecordSchema, 'SELECT data FROM ci_requests WHERE id=?', id);

    return record ? checkedRecord(record) : null;
  };

  const target = (id: string) =>
    checkedTarget(
      db.get(ciTargetSchema, 'SELECT data FROM ci_targets WHERE id=?', id) ??
        stateFailure('state_invalid_data'),
    );
  const view = (record: CiRecord) =>
    ciViewSchema.parse({ record, observation: target(record.targetId) });
  function event(record: CiRecord, kind: 'ci_requested' | 'ci_controlled' | 'ci_observed') {
    const run = runs.inspect(record.request.source.jobId);

    if (
      run.outcome !== 'completed' ||
      !run.value ||
      run.value.job.job.projectId !== record.binding.projectId
    ) {
      stateFailure('state_invalid_data');
    }

    appendRunEvent(db, run.value.job, kind, record.updatedAt, {
      requestId: record.id,
      targetId: record.targetId,
      sha: record.binding.target.sha,
      phase: record.phase,
      reason: record.reason,
      revision: record.revision,
    });
  }

  function save(record: CiRecord, kind: 'ci_requested' | 'ci_controlled' | 'ci_observed') {
    const value = checkedRecord(ciRecordSchema.parse(record));
    db.statement('UPDATE ci_requests SET phase=?,deadline_at=?,data=? WHERE id=?').run(
      value.phase,
      value.deadlineAt,
      canonicalJson(value),
      value.id,
    );
    event(value, kind);
  }

  function saveTarget(input: CiTarget) {
    const value = checkedTarget(ciTargetSchema.parse(input));
    db.statement(
      'UPDATE ci_targets SET next_refresh_at=?,claim_expires_at=?,data=? WHERE id=?',
    ).run(value.nextRefreshAt, value.claim?.expiresAt ?? null, canonicalJson(value), value.id);
  }

  function subscribers(targetId: string) {
    return db
      .statement(
        "SELECT data FROM ci_requests WHERE target_id=? AND phase='watching' ORDER BY id LIMIT 129",
      )
      .all(targetId)
      .map((row) =>
        checkedRecord(db.data(ciRecordSchema, row) ?? stateFailure('state_invalid_data')),
      );
  }

  return {
    find(id) {
      return db.read(() => {
        const record = read(id);

        return record ? view(record) : null;
      });
    },
    reserve(input) {
      return db.write(() => {
        const record = ciRecordSchema.parse(input);
        assertAutomaticCiRecord(db, record);

        if (
          record.id !==
            `ci-${configurationDigest({ source: record.request.source, key: record.request.key })}` ||
          record.targetId !== `ci-target-${configurationDigest(record.binding.target)}`
        ) {
          stateFailure('state_invalid_data');
        }

        const previous = read(record.id);

        if (previous) {
          if (!isDeepStrictEqual(previous.request, record.request)) {
            stateFailure('state_conflict');
          }

          return { value: view(previous), disposition: 'existing' };
        }

        if (
          record.phase !== 'watching' ||
          record.revision !== 0 ||
          subscribers(record.targetId).length >= 128
        ) {
          stateFailure('ci_blocked');
        }

        const prior = db.get(
          ciTargetSchema,
          'SELECT data FROM ci_targets WHERE id=?',
          record.targetId,
        );

        if (prior && !isDeepStrictEqual(prior.target, record.binding.target)) {
          stateFailure('state_conflict');
        }

        if (!prior) {
          const observation = ciTargetSchema.parse({
            id: record.targetId,
            target: record.binding.target,
            nextRefreshAt: record.createdAt,
            lastObservedAt: null,
            snapshot: null,
            error: null,
            backoff: 0,
            claim: null,
          });
          db.statement(
            'INSERT INTO ci_targets(id,next_refresh_at,claim_expires_at,data) VALUES (?,?,NULL,?)',
          ).run(observation.id, observation.nextRefreshAt, canonicalJson(observation));
        }

        db.statement(
          'INSERT INTO ci_requests(id,project_id,source_id,target_id,phase,deadline_at,data) VALUES (?,?,?,?,?,?,?)',
        ).run(
          record.id,
          record.binding.projectId,
          record.binding.sourceId,
          record.targetId,
          record.phase,
          record.deadlineAt,
          canonicalJson(record),
        );
        event(record, 'ci_requested');

        return { value: view(record), disposition: 'created' };
      });
    },
    list(input) {
      return db.read(() => {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
          stateFailure('invalid_request');
        }

        const rows = db
          .statement('SELECT data FROM ci_requests WHERE project_id=? AND id>? ORDER BY id LIMIT ?')
          .all(input.projectId, input.after, input.limit + 1);
        const items = rows
          .slice(0, input.limit)
          .map((row) =>
            checkedRecord(db.data(ciRecordSchema, row) ?? stateFailure('state_invalid_data')),
          );

        return { items, nextCursor: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null };
      });
    },
    subscribers(id) {
      return db.read(() => subscribers(id));
    },
    due(time, limit) {
      return db.read(() => {
        if (
          !Number.isSafeInteger(time) ||
          time < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 32
        ) {
          stateFailure('invalid_request');
        }

        return db
          .statement(
            "SELECT t.data FROM ci_targets t WHERE t.next_refresh_at<=? AND (t.claim_expires_at IS NULL OR t.claim_expires_at<=?) AND EXISTS (SELECT 1 FROM ci_requests r WHERE r.target_id=t.id AND r.phase='watching' AND r.deadline_at>?) ORDER BY t.next_refresh_at,t.id LIMIT ?",
          )
          .all(time, time, time, limit)
          .map((row) =>
            checkedTarget(db.data(ciTargetSchema, row) ?? stateFailure('state_invalid_data')),
          );
      });
    },
    nextWake() {
      return db.read(() => {
        const value = db
          .statement(
            "SELECT MIN(next_at) AS wake FROM (SELECT MIN(r.deadline_at,MAX(t.next_refresh_at,COALESCE(t.claim_expires_at,0))) AS next_at FROM ci_requests r JOIN ci_targets t ON t.id=r.target_id WHERE r.phase='watching')",
          )
          .get()?.wake;

        if (value === null || value === undefined) {
          return null;
        }

        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          stateFailure('state_invalid_data');
        }

        return value;
      });
    },
    expire(time) {
      return db.write(() => {
        const rows = db
          .statement(
            "SELECT data FROM ci_requests WHERE phase='watching' AND deadline_at<=? LIMIT 256",
          )
          .all(time);

        for (const row of rows) {
          const record = checkedRecord(
            db.data(ciRecordSchema, row) ?? stateFailure('state_invalid_data'),
          );
          save(
            {
              ...record,
              phase: 'blocked',
              reason: 'deadline_exceeded',
              revision: record.revision + 1,
              updatedAt: time,
            },
            'ci_controlled',
          );
        }

        return { value: { expired: rows.length }, disposition: 'updated' };
      });
    },
    control(input) {
      return db.write(() => {
        const record = read(input.id) ?? stateFailure('ci_not_found');

        if (record.revision !== input.expectedRevision) {
          stateFailure('state_conflict');
        }

        const updated = ciRecordSchema.parse({
          ...record,
          phase: input.phase,
          reason: input.reason,
          updatedAt: input.now,
          revision: record.revision + 1,
          deadlineAt: input.deadlineAt ?? record.deadlineAt,
        });
        save(updated, 'ci_controlled');

        if (updated.phase === 'watching') {
          const observation = target(updated.targetId);
          saveTarget({
            ...observation,
            nextRefreshAt: Math.min(observation.nextRefreshAt, input.now),
          });
        }

        return { value: view(updated), disposition: 'updated' };
      });
    },
    claim(input) {
      return db.write(() => {
        const policy = ciPolicySchema.parse(input.policy);
        const observation = target(input.targetId);
        const watchers = subscribers(input.targetId).filter((r) => r.deadlineAt > input.now);

        if (watchers.length > 128) {
          stateFailure('state_invalid_data');
        }

        if (
          !watchers.length ||
          observation.nextRefreshAt > input.now ||
          (observation.claim && observation.claim.expiresAt > input.now)
        ) {
          return { value: null, disposition: 'existing' };
        }

        const host = observation.target.host;
        const row = db
          .statement(
            'SELECT window_started_at,window_ends_at,used,capacity,not_before FROM ci_budgets WHERE host=?',
          )
          .get(host);
        const integer = (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
            ? value
            : stateFailure('state_invalid_data');
        let start = row ? integer(row.window_started_at) : input.now;
        let end = row ? integer(row.window_ends_at) : input.now + policy.windowMs;
        let used = row ? integer(row.used) : 0;
        let capacity = row
          ? Math.min(integer(row.capacity), policy.requestsPerWindow)
          : policy.requestsPerWindow;
        const notBefore = row ? integer(row.not_before) : 0;

        if (input.now >= end) {
          start = input.now;
          end = input.now + policy.windowMs;
          used = 0;
          capacity = policy.requestsPerWindow;
        }

        const blockedUntil =
          input.now < start
            ? end
            : Math.max(notBefore, used + policy.maxRequestsPerObservation > capacity ? end : 0);

        if (blockedUntil > input.now) {
          saveTarget({
            ...observation,
            nextRefreshAt: Math.max(observation.nextRefreshAt, blockedUntil),
          });

          return { value: null, disposition: 'updated' };
        }

        db.statement(
          'INSERT INTO ci_budgets(host,window_started_at,window_ends_at,used,capacity,not_before) VALUES (?,?,?,?,?,?) ON CONFLICT(host) DO UPDATE SET window_started_at=excluded.window_started_at,window_ends_at=excluded.window_ends_at,used=excluded.used,capacity=excluded.capacity,not_before=excluded.not_before',
        ).run(host, start, end, used + policy.maxRequestsPerObservation, capacity, notBefore);
        const claimed = ciTargetSchema.parse({
          ...observation,
          claim: {
            owner: input.owner,
            token: input.token,
            startedAt: input.now,
            expiresAt: input.now + policy.leaseMs,
            participants: watchers.map((r) => ({ id: r.id, revision: r.revision })),
          },
        });
        saveTarget(claimed);

        return { value: claimed, disposition: 'updated' };
      });
    },
    settle(input) {
      return db.write(() => {
        const observation = target(input.target.id);

        if (
          !observation.claim ||
          observation.claim.owner !== input.owner ||
          observation.claim.token !== input.token ||
          !isDeepStrictEqual(observation.target, input.target.target)
        ) {
          stateFailure('state_conflict');
        }

        for (const decision of input.decisions) {
          const record = read(decision.id) ?? stateFailure('state_invalid_data');

          if (
            !observation.claim.participants.some(
              (p) => p.id === record.id && p.revision === decision.revision,
            )
          ) {
            stateFailure('state_conflict');
          }

          if (record.phase !== 'watching' || record.revision !== decision.revision) {
            continue;
          }

          save(
            {
              ...record,
              phase: decision.phase,
              reason: decision.reason,
              revision: record.revision + 1,
              updatedAt: input.now,
            },
            'ci_observed',
          );
        }

        const saved = ciTargetSchema.parse({ ...input.target, claim: null });
        saveTarget(saved);

        if (input.retryNotBefore !== null) {
          db.statement('UPDATE ci_budgets SET not_before=MAX(not_before,?) WHERE host=?').run(
            input.retryNotBefore,
            observation.target.host,
          );
        }

        return { value: saved, disposition: 'updated' };
      });
    },
  };
}
