import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { createHerdrCliProvider } from '../adapters/herdr/cli-provider.js';
import { nodeHerdrEndpointReader } from '../adapters/filesystem/herdr-endpoint.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { hostExecutable } from '../core/host-git.js';
import { rejected } from '../contracts/operation-result.js';
import { reconcileRun } from '../application/run-reconciliation.js';
import { createCodexRunShutdownVerifier } from '../application/codex-run-shutdown.js';

/** Offline host path: acquire writer ownership before opening a writable/migrating database. */
export async function reconcileLocalRun(
  input: unknown,
  options: { stateDirectory: string; herdrExecutable?: string },
) {
  try {
    const ownership = await acquireCoordinatorOwnership(options.stateDirectory);

    try {
      const opened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: options.stateDirectory,
      });

      if (opened.outcome !== 'opened') {
        return opened;
      }

      try {
        const executable = await hostExecutable('herdr', options.herdrExecutable);

        if (!executable) {
          return rejected(
            'herdr_unavailable',
            'Select a trusted Herdr executable to verify shutdown.',
          );
        }

        return await reconcileRun(input, {
          runs: opened.runs,
          shutdown: createCodexRunShutdownVerifier({
            runtime: opened.runtime,
            provider: createHerdrCliProvider({
              executable,
              runner: nodeProcessRunner,
              endpoint: nodeHerdrEndpointReader,
            }),
            now: Date.now,
          }),
        });
      } finally {
        opened.store.close();
      }
    } finally {
      ownership.release();
    }
  } catch (error) {
    return stateRejection(error);
  }
}
