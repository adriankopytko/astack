import { createSqliteVerificationStore } from './verification-store.js';
import type { VerificationStore } from '../../ports/verification.js';
import { createSqliteHookStore } from './hook-store.js';
import type { HookStore } from '../../ports/hooks.js';
import { createSqliteAllocationStore } from './allocation-store.js';
import type { AllocationStore } from '../../ports/resources.js';
import type { CleanupStore } from '../../ports/cleanup.js';
import { createSqliteCleanupStore } from './cleanup-store.js';
import type { ReviewResultStore } from '../../ports/review-results.js';
import { createSqliteReviewResultStore } from './review-result-store.js';
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

import type { RuntimeStore } from '../../ports/runtime.js';
import { createSqliteHandoffStore } from './handoff-store.js';
import { createSqliteCiStore } from './ci-store.js';
import { createSqliteAutomaticReviewStore } from './automatic-review-store.js';
import type { AutomaticReviewStore } from '../../ports/automatic-review.js';
import type { CiStore } from '../../ports/ci.js';
import type { HandoffStore } from '../../ports/handoff.js';
import type { RunStore } from '../../ports/runs.js';
import { createSqliteRunStore } from './run-store.js';
import { createSqliteRuntimeStore } from './runtime-store.js';

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
      runtime: RuntimeStore;
      runs: RunStore;
      reviewResults: ReviewResultStore;
      cleanups: CleanupStore;
      allocations: AllocationStore;
      hooks: HookStore;
      verifications: VerificationStore;
      handoffs: HandoffStore;
      ci: CiStore;
      automaticReviews: AutomaticReviewStore;
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
        cleanups: createSqliteCleanupStore(database),
        allocations: createSqliteAllocationStore(database, dependencies.now ?? Date.now),
        hooks: createSqliteHookStore(database, dependencies.now ?? Date.now),
        verifications: createSqliteVerificationStore(database, dependencies.now ?? Date.now),
        worktrees: createSqliteWorktreeStore(database, dependencies.now ?? Date.now),
        service: createSqliteServiceStore(database, dependencies.now ?? Date.now),
        handoffs: createSqliteHandoffStore(database, dependencies.now ?? Date.now),
        ci: createSqliteCiStore(database, dependencies.now ?? Date.now),
        automaticReviews: createSqliteAutomaticReviewStore(database),
        reviewResults: createSqliteReviewResultStore(database, dependencies.now ?? Date.now),
        runs: createSqliteRunStore(database, dependencies.now ?? Date.now),
        herdr: createSqliteHerdrStore(database, dependencies.now ?? Date.now),
        runtime: createSqliteRuntimeStore(database, dependencies.now ?? Date.now),
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
