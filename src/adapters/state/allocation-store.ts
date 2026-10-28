import { isDeepStrictEqual } from 'node:util';
import {
  allocationRecordSchema,
  allocationRequestSchema,
  allocationStartSchema,
  allocationReleaseSchema,
  allocationRunningSchema,
  type AllocationRecord,
} from '../../contracts/resources.js';
import {
  stateJobSchema,
  stateAttemptSchema,
  stateResourceIntentSchema,
} from '../../contracts/state.js';
import type { AllocationStore } from '../../ports/resources.js';
import { allocationId, allocationValue, allocationKey } from '../../core/allocation.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { runControl, appendRunEvent } from './run-events.js';

export function createSqliteAllocationStore(db: StateDatabase, now: () => number): AllocationStore {
  const read = (id: string) =>
    db.get(allocationRecordSchema, 'SELECT data FROM resource_allocations WHERE id=?', id);
  function source(jobId: string, attemptId: string, active: boolean) {
    const job =
      db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', jobId) ??
      stateFailure('run_not_found');
    const attempt =
      db.get(stateAttemptSchema, 'SELECT data FROM attempts WHERE id=?', attemptId) ??
      stateFailure('state_not_found');
    const entry = db.statement('SELECT attempt_id FROM service_entries WHERE job_id=?').get(jobId);

    if (!entry || entry.attempt_id !== attemptId || attempt.jobId !== jobId) {
      stateFailure('state_conflict');
    }

    if (
      active &&
      (job.operation !== 'delegate:implementer' ||
        runControl(db, jobId).phase !== 'active' ||
        db.statement('SELECT resolved_at FROM attempts WHERE id=?').get(attemptId)?.resolved_at !==
          null)
    ) {
      stateFailure('resource_blocked');
    }

    const binding = {
      projectId: job.projectId,
      repositoryId: job.repositoryId,
      checkoutId: job.checkoutId,
      branch: attempt.branch,
      commit: attempt.commit,
    };

    return { job, attempt, binding };
  }

  function saved(id: string, revision: number, active = false) {
    const record = read(id) ?? stateFailure('state_not_found');

    if (record.revision !== revision) {
      stateFailure('state_conflict');
    }

    const current = source(record.request.jobId, record.request.attemptId, active);

    if (!isDeepStrictEqual(current.binding, record.binding)) {
      stateFailure('state_conflict');
    }

    return record;
  }

  function save(record: AllocationRecord) {
    const value = allocationRecordSchema.parse(record);
    db.statement(
      'UPDATE resource_allocations SET allocation_key=?,phase=?,revision=?,data=? WHERE id=?',
    ).run(allocationKey(value.value), value.phase, value.revision, canonicalJson(value), value.id);
    appendRunEvent(
      db,
      source(value.request.jobId, value.request.attemptId, false),
      'allocation_changed',
      value.updatedAt,
      { allocationId: value.id, phase: value.phase, revision: value.revision },
    );

    return value;
  }

  const occupied = (key: string, id: string) =>
    Boolean(
      db
        .statement(
          "SELECT id FROM resource_allocations WHERE allocation_key=? AND phase!='released' AND id<>?",
        )
        .get(key, id),
    );
  function candidate(request: AllocationRecord['request'], id: string, from: number) {
    const count = request.spec.kind === 'port' ? request.spec.candidates.length : 1;

    for (let index = from; index < count; index++) {
      const value = allocationValue(request, id, index);

      if (!occupied(allocationKey(value), id)) {
        return { value, candidateIndex: index };
      }
    }

    return stateFailure('resource_conflict');
  }

  return {
    inspect: (id) => db.read(() => read(id)),
    reserve(input) {
      return db.write(() => {
        const request = allocationRequestSchema.parse(input);
        const id = allocationId(request);
        const old = read(id);

        if (old) {
          if (!isDeepStrictEqual(old.request, request)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        const current = source(request.jobId, request.attemptId, true);
        const selection = candidate(request, id, 0);
        const timestamp = now();
        const record = allocationRecordSchema.parse({
          schemaVersion: 1,
          id,
          request,
          binding: current.binding,
          ...selection,
          phase: request.spec.kind === 'port' ? 'probing' : 'reserved',
          revision: 0,
          startup: null,
          probe: null,
          reason: null,
          endpointVerifiedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          release: null,
        });
        const hold = stateResourceIntentSchema.parse({
          id,
          attemptId: request.attemptId,
          kind: 'allocation',
          key: id,
          createdAt: timestamp,
          handle: { allocationId: id },
        });
        db.statement(
          'INSERT INTO resources(id,attempt_id,kind,resource_key,data) VALUES (?,?,?,?,?)',
        ).run(id, request.attemptId, hold.kind, id, canonicalJson(hold));
        db.statement(
          'INSERT INTO resource_allocations(id,job_id,attempt_id,project_id,request_key,allocation_key,phase,revision,data) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          request.jobId,
          request.attemptId,
          current.binding.projectId,
          request.key,
          allocationKey(record.value),
          record.phase,
          0,
          canonicalJson(record),
        );
        appendRunEvent(db, current, 'allocation_changed', timestamp, {
          allocationId: id,
          phase: record.phase,
          revision: 0,
        });

        return { value: record, disposition: 'created' };
      });
    },
    probe(input) {
      return db.write(() => {
        const old = saved(input.id, input.expectedRevision, true);

        if (
          old.value.kind !== 'port' ||
          !['probing', 'blocked', 'reserved'].includes(old.phase) ||
          old.startup !== null ||
          !['free', 'busy', 'unknown'].includes(input.observation)
        ) {
          stateFailure('resource_blocked');
        }

        const value = save({
          ...old,
          phase: input.observation === 'free' ? 'reserved' : 'blocked',
          probe: input.observation,
          reason:
            input.observation === 'free'
              ? null
              : input.observation === 'busy'
                ? 'port_busy'
                : 'probe_unknown',
          revision: old.revision + 1,
          updatedAt: now(),
        });

        return { value, disposition: 'updated' };
      });
    },
    next(input) {
      return db.write(() => {
        const old = saved(input.id, input.expectedRevision, true);

        if (
          old.phase !== 'blocked' ||
          old.probe !== 'busy' ||
          old.startup ||
          old.request.spec.kind !== 'port'
        ) {
          stateFailure('resource_blocked');
        }

        const selection = candidate(old.request, old.id, old.candidateIndex + 1);
        const value = save({
          ...old,
          ...selection,
          phase: 'probing',
          probe: null,
          reason: null,
          revision: old.revision + 1,
          updatedAt: now(),
        });

        return { value, disposition: 'updated' };
      });
    },
    start(input) {
      return db.write(() => {
        const request = allocationStartSchema.parse(input);
        const old = read(request.id) ?? stateFailure('state_not_found');

        if (
          old.startup &&
          old.startup.key === request.key &&
          old.startup.controller === request.controller &&
          old.startup.authorizedRevision === request.expectedRevision
        ) {
          return { value: old, disposition: 'existing' };
        }

        saved(old.id, request.expectedRevision, true);

        if (old.phase !== 'reserved' || old.startup) {
          stateFailure('resource_blocked');
        }

        const value = save({
          ...old,
          phase: 'starting',
          startup: {
            key: request.key,
            controller: request.controller,
            authorizedRevision: request.expectedRevision,
          },
          revision: old.revision + 1,
          updatedAt: now(),
        });

        return { value, disposition: 'updated' };
      });
    },
    running(input) {
      return db.write(() => {
        const request = allocationRunningSchema.parse(input);
        const old = saved(request.id, request.expectedRevision, true);

        if (
          old.phase !== 'starting' ||
          old.startup?.key !== request.key ||
          old.startup.controller !== request.controller
        ) {
          stateFailure('resource_blocked');
        }

        const value = save({
          ...old,
          phase: 'running',
          endpointVerifiedAt: now(),
          revision: old.revision + 1,
          updatedAt: now(),
        });

        return { value, disposition: 'updated' };
      });
    },
    retain(input) {
      return db.write(() => {
        const old = saved(input.id, input.expectedRevision);

        if (!['running', 'retained'].includes(old.phase)) {
          stateFailure('resource_blocked');
        }

        const value =
          old.phase === 'retained'
            ? old
            : save({ ...old, phase: 'retained', revision: old.revision + 1, updatedAt: now() });

        return { value, disposition: old.phase === 'retained' ? 'existing' : 'updated' };
      });
    },
    release(input) {
      return db.write(() => {
        const request = allocationReleaseSchema.parse(input);
        const old = read(request.id) ?? stateFailure('state_not_found');
        const evidence = {
          key: request.key,
          expectedRevision: request.expectedRevision,
          writersStopped: true as const,
          servicesStopped: true as const,
        };

        if (old.phase === 'released') {
          if (
            !isDeepStrictEqual(old.release, evidence) ||
            (old.startup?.key ?? null) !== request.startupKey
          ) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        saved(old.id, request.expectedRevision);

        if ((old.startup?.key ?? null) !== request.startupKey) {
          stateFailure('state_conflict');
        }

        const value = save({
          ...old,
          phase: 'released',
          revision: old.revision + 1,
          updatedAt: now(),
          release: evidence,
        });
        const changed = db
          .statement(
            'UPDATE resources SET released_at=?,release_evidence=? WHERE id=? AND attempt_id=? AND released_at IS NULL',
          )
          .run(value.updatedAt, canonicalJson(evidence), old.id, old.request.attemptId);

        if (changed.changes !== 1) {
          stateFailure('state_conflict');
        }

        return { value, disposition: 'updated' };
      });
    },
    list(input) {
      return db.read(() => {
        if (
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 100 ||
          input.after.length > 128
        ) {
          stateFailure('invalid_request');
        }

        const rows = input.projectId
          ? db
              .statement(
                'SELECT data FROM resource_allocations WHERE project_id=? AND id>? ORDER BY id LIMIT ?',
              )
              .all(input.projectId, input.after, input.limit + 1)
          : db
              .statement('SELECT data FROM resource_allocations WHERE id>? ORDER BY id LIMIT ?')
              .all(input.after, input.limit + 1);
        const items = rows
          .slice(0, input.limit)
          .map((row) => db.data(allocationRecordSchema, row) ?? stateFailure('state_invalid_data'));

        return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null };
      });
    },
  };
}
