import { randomUUID } from 'node:crypto';
import { serviceErrorSchema, type ServiceError } from '../../contracts/errors.js';
import type { ErrorStore } from '../../ports/errors.js';
import { canonicalJson, type StateDatabase } from './database.js';

/** Append inside an existing transaction when reporting a durable queue blocker. */
export function appendServiceError(
  db: StateDatabase,
  value: Omit<ServiceError, 'id' | 'createdAt'>,
  now: number,
): ServiceError {
  const error = serviceErrorSchema.parse({ ...value, id: randomUUID(), createdAt: now });
  db.statement('INSERT INTO service_errors(id,created_at,data) VALUES (?,?,?)').run(
    error.id,
    error.createdAt,
    canonicalJson(error),
  );

  return error;
}

export function createSqliteErrorStore(db: StateDatabase, now: () => number): ErrorStore {
  return {
    append: (value) =>
      db.write(() => ({ value: appendServiceError(db, value, now()), disposition: 'created' })),
    list: (limit) =>
      db.read(() =>
        db
          .statement('SELECT data FROM service_errors ORDER BY created_at DESC, rowid DESC LIMIT ?')
          .all(limit)
          .map((row) => db.data(serviceErrorSchema, row)!),
      ),
    read: (id) =>
      db.read(() => db.get(serviceErrorSchema, 'SELECT data FROM service_errors WHERE id=?', id)),
  };
}
