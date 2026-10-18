import {
  runtimeSessionSchema,
  runtimeActionSchema,
  runtimeInputRetrySchema,
  type RuntimeSession,
} from '../../contracts/runtime.js';
import { serviceEntrySchema } from '../../contracts/service.js';
import { herdrSpaceSchema } from '../../contracts/herdr.js';
import { stateResourceIntentSchema } from '../../contracts/state.js';
import type { RuntimeStore } from '../../ports/runtime.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';

export function createSqliteRuntimeStore(db: StateDatabase, now: () => number): RuntimeStore {
  const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  const read = (id: string) =>
    db.get(runtimeSessionSchema, 'SELECT data FROM runtime_sessions WHERE attempt_id=?', id);
  const action = (id: string, key: string) =>
    db.get(
      runtimeActionSchema,
      'SELECT data FROM runtime_actions WHERE attempt_id=? AND action_key=?',
      id,
      key,
    );
  const pending = (id: string) =>
    db.get(
      runtimeActionSchema,
      "SELECT data FROM runtime_actions WHERE attempt_id=? AND state='pending'",
      id,
    );
  const inputRetry = (id: string, key: string, generation: number) =>
    db.get(
      runtimeInputRetrySchema,
      'SELECT data FROM runtime_input_retries WHERE attempt_id=? AND action_key=? AND generation=?',
      id,
      key,
      generation,
    );
  function checked(previous: RuntimeSession) {
    const current = read(previous.attemptId);

    if (!current || !same(current, previous)) {
      stateFailure('runtime_conflict');
    }

    return current;
  }

  function active(session: RuntimeSession) {
    const entry = db.get(
      serviceEntrySchema,
      'SELECT data FROM service_entries WHERE job_id=?',
      session.jobId,
    );
    const attempt = db
      .statement('SELECT resolved_at FROM attempts WHERE id=?')
      .get(session.attemptId);

    if (
      !entry ||
      entry.attemptId !== session.attemptId ||
      entry.effectId !== session.effectId ||
      !entry.claim ||
      !['dispatching', 'started', 'unknown'].includes(entry.state) ||
      !attempt ||
      attempt.resolved_at !== null
    ) {
      stateFailure('runtime_conflict');
    }
  }

  return {
    read: (id) => db.read(() => read(id)),
    action: (id, key) => db.read(() => action(id, key)),
    pending: (id) => db.read(() => pending(id)),
    inputRetry: (id, key, generation) => db.read(() => inputRetry(id, key, generation)),
    reserve(input) {
      return db.write(() => {
        const value = runtimeSessionSchema.parse(input);
        const existing = read(value.attemptId);

        if (existing) {
          return { value: existing, disposition: 'existing' };
        }

        active(value);
        const space = db.get(
          herdrSpaceSchema,
          'SELECT data FROM herdr_spaces WHERE id=?',
          value.space.id,
        );

        if (value.phase !== 'pending' || value.agent !== null || !same(space, value.space)) {
          stateFailure('runtime_conflict');
        }

        db.statement(
          'INSERT INTO runtime_sessions(attempt_id, job_id, effect_id, launch_id, space_id, data) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          value.attemptId,
          value.jobId,
          value.effectId,
          value.launchId,
          value.space.id,
          canonicalJson(value),
        );
        const resource = stateResourceIntentSchema.parse({
          id: `runtime:${value.launchId}`,
          attemptId: value.attemptId,
          kind: 'interactive-runtime',
          key: value.launchId,
          createdAt: now(),
          handle: { runtime: value.runtime, launchId: value.launchId, spaceId: value.space.id },
        });
        db.statement(
          'INSERT INTO resources(id, attempt_id, kind, resource_key, data) VALUES (?, ?, ?, ?, ?)',
        ).run(
          resource.id,
          resource.attemptId,
          resource.kind,
          resource.key,
          canonicalJson(resource),
        );

        return { value, disposition: 'created' };
      });
    },
    bind(previous, input) {
      return db.write(() => {
        const current = checked(previous);
        const next = runtimeSessionSchema.parse(input);

        if (
          current.phase !== 'pending' ||
          next.phase !== 'ready' ||
          !same({ ...next, phase: current.phase, agent: current.agent }, current)
        ) {
          stateFailure('runtime_conflict');
        }

        db.statement('UPDATE runtime_sessions SET data=? WHERE attempt_id=?').run(
          canonicalJson(next),
          next.attemptId,
        );

        return { value: next, disposition: 'updated' };
      });
    },
    reserveAction(session, input) {
      return db.write(() => {
        checked(session);
        active(session);
        let value = runtimeActionSchema.parse(input);
        const existing = action(value.attemptId, value.key);

        if (existing) {
          if (!same({ ...existing, state: value.state, generation: value.generation }, value)) {
            stateFailure('runtime_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        const previous = db.get(
          runtimeInputRetrySchema,
          'SELECT data FROM runtime_input_retries WHERE attempt_id=? AND action_key=? ORDER BY generation DESC LIMIT 1',
          value.attemptId,
          value.key,
        );

        if (previous) {
          if (
            value.kind !== 'input' ||
            value.digest !== previous.digest ||
            previous.launchId !== session.launchId
          ) {
            stateFailure('runtime_conflict');
          }

          value = runtimeActionSchema.parse({ ...value, generation: previous.generation + 1 });
        }

        if (
          session.phase !== 'ready' ||
          session.attemptId !== value.attemptId ||
          value.state !== 'pending' ||
          pending(value.attemptId)
        ) {
          stateFailure('runtime_conflict');
        }

        db.statement(
          'INSERT INTO runtime_actions(attempt_id, action_key, state, data) VALUES (?, ?, ?, ?)',
        ).run(value.attemptId, value.key, value.state, canonicalJson(value));

        return { value, disposition: 'created' };
      });
    },
    acknowledge(previous) {
      return db.write(() => {
        const current = action(previous.attemptId, previous.key);

        if (!current || !same(current, previous)) {
          stateFailure('runtime_conflict');
        }

        const next = runtimeActionSchema.parse({ ...current, state: 'acknowledged' });
        db.statement(
          'UPDATE runtime_actions SET state=?, data=? WHERE attempt_id=? AND action_key=?',
        ).run(next.state, canonicalJson(next), next.attemptId, next.key);

        return { value: next, disposition: 'updated' };
      });
    },
    authorizeInputRetry(session, previous) {
      return db.write(() => {
        checked(session);
        active(session);
        const value = runtimeActionSchema.parse(previous);
        const existing = inputRetry(value.attemptId, value.key, value.generation);

        if (existing) {
          if (existing.digest !== value.digest || existing.launchId !== session.launchId) {
            stateFailure('runtime_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        const current = action(value.attemptId, value.key);
        const control = db
          .statement(
            "SELECT json_extract(data,'$.phase') AS phase FROM run_controls WHERE job_id=?",
          )
          .get(session.jobId);

        if (
          (control && control.phase !== 'active') ||
          session.phase !== 'ready' ||
          session.attemptId !== value.attemptId ||
          value.kind !== 'input' ||
          value.state !== 'pending' ||
          !current ||
          !same(current, value)
        ) {
          stateFailure('runtime_conflict');
        }

        const recovery = runtimeInputRetrySchema.parse({
          attemptId: value.attemptId,
          key: value.key,
          digest: value.digest,
          generation: value.generation,
          launchId: session.launchId,
          source: 'host-attestation',
          notSubmitted: true,
          writerStopped: true,
          authorizedAt: now(),
        });
        db.statement(
          'INSERT INTO runtime_input_retries(attempt_id,action_key,generation,data) VALUES (?,?,?,?)',
        ).run(value.attemptId, value.key, value.generation, canonicalJson(recovery));
        db.statement('DELETE FROM runtime_actions WHERE attempt_id=? AND action_key=?').run(
          value.attemptId,
          value.key,
        );

        return { value: recovery, disposition: 'created' };
      });
    },
  };
}
