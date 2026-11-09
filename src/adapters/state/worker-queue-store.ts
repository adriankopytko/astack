import { workerQueueItemSchema, type WorkerQueueItem } from '../../contracts/worker-queue.js';
import type { WorkerQueueStore } from '../../ports/worker-queue.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { worktreeRecordSchema } from '../../contracts/worktrees.js';
import { workerWorktreeKey } from '../../core/worker-key.js';

export function createSqliteWorkerQueueStore(db: StateDatabase): WorkerQueueStore {
  function read(id: string) {
    return db.get(workerQueueItemSchema, 'SELECT data FROM worker_requests WHERE id=?', id);
  }

  function save(item: WorkerQueueItem) {
    db.statement('UPDATE worker_requests SET state=?,data=? WHERE id=?').run(
      item.state,
      canonicalJson(item),
      item.id,
    );

    return item;
  }

  return {
    enqueue(input) {
      return db.write(() => {
        const item = workerQueueItemSchema.parse(input);
        const prior = db.get(
          workerQueueItemSchema,
          'SELECT data FROM worker_requests WHERE project_id=? AND kind=? AND request_key=?',
          item.request.submission.projectId,
          item.request.kind,
          item.request.submission.key,
        );

        if (prior) {
          if (canonicalJson(prior.request) !== canonicalJson(item.request)) {
            stateFailure('state_conflict');
          }

          return { value: prior, disposition: 'existing' };
        }

        if (item.state !== 'queued' || item.error !== null || item.jobId !== null) {
          stateFailure('state_invalid_data');
        }

        db.statement(
          'INSERT INTO worker_requests(id,project_id,kind,request_key,state,created_at,data) VALUES (?,?,?,?,?,?,?)',
        ).run(
          item.id,
          item.request.submission.projectId,
          item.request.kind,
          item.request.submission.key,
          item.state,
          item.createdAt,
          canonicalJson(item),
        );

        return { value: item, disposition: 'created' };
      });
    },
    read: (id) => db.read(() => read(id)),
    find: (projectId, kind, key) =>
      db.read(() =>
        db.get(
          workerQueueItemSchema,
          'SELECT data FROM worker_requests WHERE project_id=? AND kind=? AND request_key=?',
          projectId,
          kind,
          key,
        ),
      ),
    counts: () =>
      db.read(() => {
        const rows = db
          .statement(
            "SELECT state,COUNT(*) AS count FROM worker_requests WHERE state IN ('queued','preparing') GROUP BY state",
          )
          .all();
        const counts = { queued: 0, preparing: 0 };

        for (const row of rows) {
          if (row.state === 'queued' || row.state === 'preparing') {
            counts[row.state] = Number(row.count);
          }
        }

        return counts;
      }),
    reservations: (excludeId) =>
      db.read(() => {
        const rows = db
          .statement(
            "SELECT COALESCE(json_extract(data, '$.request.submission.agent'),kind) AS role,COUNT(*) AS count FROM worker_requests WHERE state IN ('preparing','prepared') AND id<>? GROUP BY role",
          )
          .all(excludeId);
        const roles: Record<string, number> = {};
        let global = 0;

        for (const row of rows) {
          const count = Number(row.count);
          roles[String(row.role)] = count;
          global += count;
        }

        return { global, roles };
      }),
    claim(limits, available) {
      return db.write(() => {
        const active = db
          .statement(
            "SELECT role,COUNT(*) AS count FROM service_entries WHERE state IN ('dispatching','started','unknown') GROUP BY role",
          )
          .all();
        const reservations = db
          .statement(
            "SELECT COALESCE(json_extract(data, '$.request.submission.agent'),kind) AS role,COUNT(*) AS count FROM worker_requests WHERE state IN ('preparing','prepared') GROUP BY role",
          )
          .all();
        const counts = new Map<string, number>();

        for (const row of [...active, ...reservations]) {
          const role = String(row.role);
          counts.set(role, (counts.get(role) ?? 0) + Number(row.count));
        }

        const total = [...counts.values()].reduce((sum, value) => sum + value, 0);

        if (total >= limits.global) {
          return { value: null, disposition: 'existing' };
        }

        const rows = db
          .statement("SELECT data FROM worker_requests WHERE state='queued' ORDER BY created_at,id")
          .iterate();

        for (const row of rows) {
          const item = db.data(workerQueueItemSchema, row)!;
          const agent = item.request.submission.agent ?? item.request.kind;
          const limit = limits.perRole[agent] ?? limits.defaultRole;

          if (
            (counts.get(agent) ?? 0) < limit &&
            available[item.request.kind]?.includes(item.runtime)
          ) {
            return { value: save({ ...item, state: 'preparing' }), disposition: 'updated' };
          }
        }

        return { value: null, disposition: 'existing' };
      });
    },
    block(id, error) {
      return db.write(() => {
        const item = read(id) ?? stateFailure('state_not_found');

        if (item.state !== 'preparing') {
          stateFailure('state_conflict');
        }

        return {
          value: save({
            ...item,
            state: item.cancelRequested ? 'cancelled' : 'blocked',
            error: item.cancelRequested ? null : error,
          }),
          disposition: 'updated',
        };
      });
    },
    uncertain(id, error) {
      return db.write(() => {
        const item = read(id) ?? stateFailure('state_not_found');

        if (item.state !== 'preparing') {
          stateFailure('state_conflict');
        }

        return { value: save({ ...item, error }), disposition: 'updated' };
      });
    },
    alias(id, jobId) {
      return db.write(() => {
        const item = read(id) ?? stateFailure('state_not_found');

        if (item.state !== 'preparing') {
          stateFailure('state_conflict');
        }

        return { value: save({ ...item, state: 'started', jobId }), disposition: 'updated' };
      });
    },
    reconciled(worktree) {
      return db.write(() => {
        const saved = db.get(
          worktreeRecordSchema,
          'SELECT data FROM managed_worktrees WHERE id=?',
          worktree.intent.id,
        );

        if (
          !saved ||
          canonicalJson(saved) !== canonicalJson(worktree) ||
          saved.reconciliation?.operationId !== saved.operationId
        ) {
          stateFailure('worktree_conflict');
        }

        const rows = db
          .statement("SELECT data FROM worker_requests WHERE project_id=? AND state='preparing'")
          .all(saved.intent.projectId);

        for (const row of rows) {
          const item = db.data(workerQueueItemSchema, row)!;

          if (workerWorktreeKey(item.request.kind, item.request.submission) !== saved.intent.key) {
            continue;
          }

          if (saved.phase === 'ready') {
            return {
              value: save({
                ...item,
                state: item.cancelRequested ? 'cancelled' : 'queued',
                error: null,
              }),
              disposition: 'updated',
            };
          }

          if (saved.phase === 'abandoned') {
            return {
              value: save({
                ...item,
                state: item.cancelRequested ? 'cancelled' : 'blocked',
                error: item.cancelRequested
                  ? null
                  : {
                      code: 'worktree_conflict',
                      message:
                        'The interrupted worktree was absent; submit a new task key after inspection.',
                    },
              }),
              disposition: 'updated',
            };
          }
        }

        return { value: null, disposition: 'existing' };
      });
    },
    reconcileAbsent(id) {
      return db.write(() => {
        const item = read(id) ?? stateFailure('state_not_found');

        if (item.state !== 'preparing') {
          stateFailure('state_conflict');
        }

        const tree = db
          .statement('SELECT id FROM managed_worktrees WHERE project_id=? AND owner_key=?')
          .get(
            item.request.submission.projectId,
            workerWorktreeKey(item.request.kind, item.request.submission),
          );

        if (tree) {
          stateFailure('worktree_conflict');
        }

        return {
          value: save({
            ...item,
            state: item.cancelRequested ? 'cancelled' : 'queued',
            error: null,
          }),
          disposition: 'updated',
        };
      });
    },
    cancel(id) {
      return db.write(() => {
        const item = read(id) ?? stateFailure('state_not_found');

        if (item.state === 'cancelled') {
          return { value: item, disposition: 'existing' };
        }

        if (item.state === 'preparing') {
          return { value: save({ ...item, cancelRequested: true }), disposition: 'updated' };
        }

        if (item.state !== 'queued' && item.state !== 'blocked') {
          stateFailure('state_conflict');
        }

        return {
          value: save({ ...item, state: 'cancelled', error: null }),
          disposition: 'updated',
        };
      });
    },
  };
}
