import { stateOpenRequestSchema } from '../../contracts/state.js';
import { rejected, type RejectedResult } from '../../contracts/operation-result.js';
import { parseOperationRequest } from '../../core/parse-operation-request.js';
import { FileSafetyError } from '../../core/file-paths.js';
import type { StateStore } from '../../ports/state-store.js';
import { openStateDatabase } from './database.js';
import { StateError, stateRejection } from './errors.js';
import { auditStateFiles, prepareStateDirectory } from './state-directory.js';
import { createStateStore } from './store.js';
import { createSqliteProjectRegistry } from './project-registry.js';
import type { ProjectRegistry } from '../../ports/project-registry.js';
import type { WorktreeStore } from '../../ports/worktrees.js';
import { createSqliteWorktreeStore } from './worktree-store.js';
import { createSqliteServiceStore } from './service-store.js';
import type { ServiceStore } from '../../ports/service.js';
import type { HerdrStore } from '../../ports/herdr.js';
import { createSqliteHerdrStore } from './herdr-store.js';

export interface SqliteStateDependencies {
  /** Trusted wall-clock milliseconds, used only for short claims and release observations. */
  now?: () => number;
}
export type StateOpenResult =
  | {
      schemaVersion: 1;
      outcome: 'opened';
      stateDirectory: string;
      store: StateStore;
      registry: ProjectRegistry;
      worktrees: WorktreeStore;
      service: ServiceStore;
      herdr: HerdrStore;
    }
  | RejectedResult;

export async function openSqliteState(
  input: unknown,
  dependencies: SqliteStateDependencies = {},
): Promise<StateOpenResult> {
  const request = parseOperationRequest(stateOpenRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return rejected(
      'unsupported_platform',
      'Private SQLite state currently requires Linux or macOS.',
    );
  }

  try {
    const readOnly = request.value.mode === 'read-only';
    const { root, databasePath } = await prepareStateDirectory(
      request.value.stateDirectory,
      readOnly,
    );
    const database = openStateDatabase(databasePath, request.value.busyTimeoutMs, readOnly);

    try {
      await auditStateFiles(root);

      return {
        schemaVersion: 1,
        outcome: 'opened',
        stateDirectory: root.path,
        store: createStateStore(database, dependencies.now ?? Date.now),
        registry: createSqliteProjectRegistry(database),
        worktrees: createSqliteWorktreeStore(database, dependencies.now ?? Date.now),
        service: createSqliteServiceStore(database),
        herdr: createSqliteHerdrStore(database, dependencies.now ?? Date.now),
      };
    } catch (error) {
      database.close();

      throw error;
    }
  } catch (error) {
    return stateRejection(
      error instanceof FileSafetyError ? new StateError('state_directory_unsafe') : error,
    );
  }
}
