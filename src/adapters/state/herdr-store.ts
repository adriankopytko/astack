import { herdrSettingsSchema, herdrSpaceSchema, type HerdrSpace } from '../../contracts/herdr.js';
import { worktreeRecordSchema } from '../../contracts/worktrees.js';
import { stateResourceIntentSchema } from '../../contracts/state.js';
import type { HerdrStore } from '../../ports/herdr.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';

export function createSqliteHerdrStore(db: StateDatabase, now: () => number): HerdrStore {
  const read = (id: string) =>
    db.get(herdrSpaceSchema, 'SELECT data FROM herdr_spaces WHERE id=?', id);
  const settings = (id: string) =>
    db.get(herdrSettingsSchema, 'SELECT data FROM herdr_projects WHERE project_id=?', id);
  const primary = (id: string) =>
    db.get(
      herdrSpaceSchema,
      "SELECT data FROM herdr_spaces WHERE project_id=? AND kind='primary'",
      id,
    );
  const worker = (id: string) =>
    db.get(herdrSpaceSchema, 'SELECT data FROM herdr_spaces WHERE attempt_id=?', id);

  function same(left: unknown, right: unknown): boolean {
    return canonicalJson(left) === canonicalJson(right);
  }

  function valid(record: HerdrSpace): HerdrSpace {
    const result = herdrSpaceSchema.safeParse(record);

    if (!result.success || JSON.stringify(result.data).length > 32_768) {
      stateFailure('state_invalid_data');
    }

    return result.data;
  }

  function checked(previous: HerdrSpace): HerdrSpace {
    const current = read(previous.id);

    if (!current || !same(current, previous)) {
      stateFailure('herdr_conflict');
    }

    return current;
  }

  function update(record: HerdrSpace): HerdrSpace {
    db.statement('UPDATE herdr_spaces SET data=? WHERE id=?').run(
      canonicalJson(valid(record)),
      record.id,
    );

    return read(record.id) ?? stateFailure('state_invalid_data');
  }

  return {
    settings: (id) => db.read(() => settings(id)),
    primary: (id) => db.read(() => primary(id)),
    worker: (id) => db.read(() => worker(id)),
    read: (id) => db.read(() => read(id)),
    managedCheckout: (id) =>
      db.read(() =>
        db.get(
          worktreeRecordSchema,
          "SELECT data FROM managed_worktrees WHERE json_extract(data, '$.intent.checkoutId')=?",
          id,
        ),
      ),
    configure(input) {
      return db.write(() => {
        const value = herdrSettingsSchema.parse(input);
        const existing = settings(value.projectId);

        if (existing) {
          if (!same(existing, value)) {
            stateFailure('herdr_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        const row = db
          .statement('SELECT repository_id FROM project_registrations WHERE project_id=?')
          .get(value.projectId);
        const checkout = db
          .statement(
            'SELECT location FROM registered_checkouts WHERE checkout_id=? AND project_id=?',
          )
          .get(value.primaryCheckoutId, value.projectId);

        if (
          !row ||
          row.repository_id !== value.repositoryId ||
          !checkout ||
          !same(JSON.parse(String(checkout.location)) as unknown, value.location)
        ) {
          stateFailure('herdr_conflict');
        }

        db.statement('INSERT INTO herdr_projects(project_id, data) VALUES (?, ?)').run(
          value.projectId,
          canonicalJson(value),
        );

        return { value, disposition: 'created' };
      });
    },
    reserve(input) {
      return db.write(() => {
        const value = valid(input);
        const config = settings(value.projectId);

        if (
          !config ||
          !same(config.target, value.target) ||
          value.repositoryId !== config.repositoryId ||
          value.phase !== 'pending' ||
          value.handle !== null ||
          value.agent !== null
        ) {
          stateFailure('herdr_conflict');
        }

        const existing =
          value.kind === 'primary' ? primary(value.projectId) : worker(value.attemptId ?? '');

        if (existing) {
          return { value: existing, disposition: 'existing' };
        }

        if (value.kind === 'primary') {
          if (
            value.checkoutId !== config.primaryCheckoutId ||
            value.root !== config.root ||
            !same(value.location, config.location)
          ) {
            stateFailure('herdr_conflict');
          }
        } else {
          const row = db
            .statement(
              'SELECT jobs.project_id, jobs.repository_id, jobs.checkout_id, attempts.data FROM attempts JOIN jobs ON jobs.id=attempts.job_id WHERE attempts.id=?',
            )
            .get(value.attemptId ?? '');
          const managed = db.get(
            worktreeRecordSchema,
            "SELECT data FROM managed_worktrees WHERE json_extract(data, '$.intent.checkoutId')=?",
            value.checkoutId,
          );
          const assigned = row
            ? (JSON.parse(String(row.data)) as { branch?: unknown; commit?: unknown })
            : null;
          const parent = primary(value.projectId);

          if (
            !row ||
            row.project_id !== value.projectId ||
            row.repository_id !== value.repositoryId ||
            row.checkout_id !== value.checkoutId ||
            assigned?.branch !== value.branch ||
            assigned.commit !== value.commit ||
            managed?.phase !== 'ready' ||
            !same(managed.location, value.location) ||
            value.primaryRoot !== config.root ||
            parent?.phase !== 'ready' ||
            parent.handle?.workspaceId !== value.primaryWorkspaceId ||
            !same(parent.server, value.server)
          ) {
            stateFailure('herdr_conflict');
          }
        }

        db.statement(
          'INSERT INTO herdr_spaces(id, project_id, checkout_id, attempt_id, kind, data) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          value.id,
          value.projectId,
          value.checkoutId,
          value.attemptId,
          value.kind,
          canonicalJson(value),
        );

        return { value, disposition: 'created' };
      });
    },
    replacePrimary(previous, next) {
      return db.write(() => {
        const current = checked(previous);

        if (
          current.kind !== 'primary' ||
          current.phase !== 'ready' ||
          next.phase !== 'pending' ||
          next.revision !== current.revision + 1 ||
          !same(
            {
              ...next,
              server: current.server,
              operationId: current.operationId,
              revision: current.revision,
              phase: current.phase,
              handle: current.handle,
            },
            current,
          )
        ) {
          stateFailure('herdr_conflict');
        }

        return { value: update(next), disposition: 'updated' };
      });
    },
    finish(previous, next) {
      return db.write(() => {
        const current = checked(previous);

        if (
          current.phase !== 'pending' ||
          next.phase !== 'ready' ||
          !same({ ...next, phase: current.phase, handle: current.handle }, current)
        ) {
          stateFailure('herdr_conflict');
        }

        if (next.attemptId) {
          const resource = stateResourceIntentSchema.parse({
            id: `herdr:${next.id}`,
            attemptId: next.attemptId,
            kind: 'herdr-space',
            key: next.id,
            createdAt: now(),
            handle: { target: next.target, server: next.server, layout: next.handle },
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
        }

        return { value: update(next), disposition: 'updated' };
      });
    },
    bindAgent(previous, agent) {
      return db.write(() => {
        const current = checked(previous);

        if (
          current.kind !== 'worker' ||
          current.phase !== 'ready' ||
          agent.name !== current.expectedAgentName ||
          (current.agent && !same(current.agent, agent))
        ) {
          stateFailure('herdr_conflict');
        }

        if (!current.agent && current.attemptId) {
          const resource = stateResourceIntentSchema.parse({
            id: `agent:${current.id}`,
            attemptId: current.attemptId,
            kind: 'herdr-agent',
            key: current.id,
            createdAt: now(),
            handle: {
              target: current.target,
              server: current.server,
              layout: current.handle,
              agent,
            },
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
        }

        return {
          value: update({ ...current, agent }),
          disposition: current.agent ? 'existing' : 'updated',
        };
      });
    },
  };
}
