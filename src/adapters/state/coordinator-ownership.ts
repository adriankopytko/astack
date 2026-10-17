import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import type { CoordinatorOwnership } from '../../ports/service.js';
import { exclusiveFile, hasFileCode, checkedFilePath, sameFile } from '../../core/file-paths.js';
import { prepareStateDirectory, auditStateFiles } from './state-directory.js';
import { StateError, sqliteCode, stateFailure } from './errors.js';

/** Kernel-backed SQLite lock, on a separate local file so job transactions stay short. */
export async function acquireCoordinatorOwnership(
  stateDirectory: string,
): Promise<CoordinatorOwnership> {
  const { root } = await prepareStateDirectory(stateDirectory, true);
  const path = await checkedFilePath(root, 'coordinator.sqlite');

  try {
    const file = await exclusiveFile(root, 'coordinator.sqlite');
    await file.close();
  } catch (error) {
    if (!hasFileCode(error, 'EEXIST')) {
      throw error;
    }
  }

  await auditStateFiles(root);
  const before = await lstat(path, { bigint: true });
  const db = new DatabaseSync(path, {
    timeout: 0,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });

  try {
    if (!sameFile(before, await lstat(path, { bigint: true }))) {
      stateFailure('state_directory_unsafe');
    }

    db.exec('PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    const id = db.prepare('PRAGMA application_id').get()?.application_id;

    if (
      version === 0 &&
      id === 0 &&
      !db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
    ) {
      db.exec(
        'CREATE TABLE coordinator_format (version INTEGER PRIMARY KEY CHECK(version=1)) STRICT; INSERT INTO coordinator_format VALUES(1); PRAGMA application_id=1095980108; PRAGMA user_version=1; COMMIT; BEGIN EXCLUSIVE;',
      );
    } else if (
      version !== 1 ||
      id !== 1095980108 ||
      db.prepare('SELECT version FROM coordinator_format').get()?.version !== 1
    ) {
      stateFailure('state_schema_mismatch');
    }

    await auditStateFiles(root);
    let released = false;

    return {
      release() {
        if (!released) {
          db.close();
          released = true;
        }
      },
    };
  } catch (error) {
    db.close();

    if (sqliteCode(error) === 5 || sqliteCode(error) === 6) {
      throw new StateError('service_already_running');
    }

    throw error;
  }
}
