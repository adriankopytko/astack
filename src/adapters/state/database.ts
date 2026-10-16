import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { completed, type OperationResult } from '../../contracts/operation-result.js';
import type { StateWriteResult } from '../../contracts/state.js';
import { sha256 } from '../../core/file-paths.js';
import { stateMigrations } from './migrations.js';
import { StateError, sqliteCode, stateFailure, stateRejection } from './errors.js';

export const stateApplicationId = 0x4153544b;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }

    return item;
  });
}

function verifyHistory(db: DatabaseSync): number {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  const applicationId = db.prepare('PRAGMA application_id').get()?.application_id;

  if (
    typeof version !== 'number' ||
    version < 0 ||
    version > stateMigrations.length ||
    (version === 0 ? applicationId !== 0 : applicationId !== stateApplicationId)
  ) {
    stateFailure('state_schema_mismatch');
  }

  if (version === 0) {
    if (db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      stateFailure('state_schema_mismatch');
    }
  } else {
    const rows = db
      .prepare('SELECT version, checksum FROM state_migrations ORDER BY version')
      .all();

    if (
      rows.length !== version ||
      rows.some(
        (row, index) =>
          row.version !== stateMigrations[index]?.version ||
          row.checksum !== sha256(stateMigrations[index]?.sql ?? ''),
      )
    ) {
      stateFailure('state_schema_mismatch');
    }
  }

  return version;
}

export function openStateDatabase(
  path: string,
  busyTimeoutMs: number,
  readOnly = false,
): StateDatabase {
  const db = new DatabaseSync(path, {
    timeout: busyTimeoutMs,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    readOnly,
  });

  try {
    const initialVersion = verifyHistory(db);

    if (readOnly) {
      if (initialVersion !== stateMigrations.length) {
        stateFailure('state_schema_mismatch');
      }

      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');

      return new StateDatabase(db, true);
    }

    db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA locking_mode=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA wal_autocheckpoint=1000;',
    );
    const mode = db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode;

    if (
      mode !== 'wal' ||
      db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
      db.prepare('PRAGMA synchronous').get()?.synchronous !== 2
    ) {
      stateFailure('state_unavailable');
    }

    db.exec('BEGIN IMMEDIATE');

    try {
      const version = verifyHistory(db);

      for (const migration of stateMigrations.slice(version)) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO state_migrations(version, checksum) VALUES (?, ?)').run(
          migration.version,
          sha256(migration.sql),
        );
        db.exec(
          `PRAGMA application_id=${stateApplicationId}; PRAGMA user_version=${migration.version};`,
        );
      }

      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK');
      }

      throw error;
    }

    return new StateDatabase(db);
  } catch (error) {
    db.close();

    throw error;
  }
}

/** Only adapter-owned SQL and synchronous callbacks enter these transactions. */
export class StateDatabase {
  private readonly statements = new Map<string, StatementSync>();
  private poisoned = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly readOnly = false,
  ) {}

  statement(sql: string): StatementSync {
    if (this.poisoned || !this.db.isOpen) {
      stateFailure('state_closed');
    }

    let statement = this.statements.get(sql);

    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }

    return statement;
  }

  data<T extends z.ZodType>(schema: T, row: unknown): z.output<T> | null {
    if (row === undefined) {
      return null;
    }

    const wrapper = z.object({ data: z.string().max(32_768) }).safeParse(row);

    if (!wrapper.success) {
      return stateFailure('state_invalid_data');
    }

    let value: unknown;

    try {
      value = JSON.parse(wrapper.data.data);
    } catch {
      return stateFailure('state_invalid_data');
    }

    const parsed = schema.safeParse(value);

    if (!parsed.success) {
      return stateFailure('state_invalid_data');
    }

    return parsed.data;
  }

  get<T extends z.ZodType>(schema: T, sql: string, ...args: SQLInputValue[]): z.output<T> | null {
    return this.data(schema, this.statement(sql).get(...args));
  }

  write<T>(
    operation: () => { value: T; disposition: 'created' | 'existing' | 'updated' },
  ): StateWriteResult<T> {
    if (this.readOnly) {
      return stateRejection(new StateError('state_read_only'));
    }

    let committing = false;
    let began = false;

    try {
      this.statement('BEGIN IMMEDIATE').run();
      began = true;
      const result = operation();
      committing = true;
      this.statement('COMMIT').run();

      return { schemaVersion: 1, outcome: 'persisted', ...result };
    } catch (error) {
      let rollbackFailed = false;

      if (began && this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          rollbackFailed = true;
        }
      }

      const code = sqliteCode(error);

      if (rollbackFailed || (committing && code !== 5 && code !== 6 && code !== 19)) {
        this.poisoned = true;

        return {
          schemaVersion: 1,
          outcome: 'uncertain',
          error: {
            code: 'state_write_uncertain',
            message:
              'The transaction outcome is uncertain; reopen and inspect stable record IDs before retrying effects.',
          },
        };
      }

      return stateRejection(error);
    }
  }

  read<T>(operation: () => T): OperationResult<T> {
    try {
      this.statement('SELECT 1');

      return completed(operation());
    } catch (error) {
      return stateRejection(error);
    }
  }

  close(): OperationResult<{ closed: true }> {
    try {
      if (this.db.isOpen) {
        this.db.close();
      }

      this.statements.clear();

      return completed({ closed: true });
    } catch (error) {
      return stateRejection(error);
    }
  }
}
