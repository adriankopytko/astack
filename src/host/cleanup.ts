import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { prepareStateDirectory } from '../adapters/state/state-directory.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { createWorktreeGit } from '../adapters/git/worktree-git.js';
import { createHerdrCliProvider } from '../adapters/herdr/cli-provider.js';
import { nodeHerdrEndpointReader } from '../adapters/filesystem/herdr-endpoint.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { gitExecutable, hostExecutable } from '../core/host-git.js';
import { rejected } from '../contracts/operation-result.js';
import { createCodexRunShutdownVerifier } from '../application/codex-run-shutdown.js';
import {
  requestCleanup,
  executeCleanup,
  reconcileCleanup,
  controlCleanup,
  type CleanupDependencies,
} from '../application/cleanup.js';

export function composeCleanupDependencies(
  opened: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>,
  executable: string,
  herdr: string | null,
): CleanupDependencies {
  const managedRoot = join(opened.stateDirectory, 'worktrees');

  return {
    cleanups: opened.cleanups,
    runs: opened.runs,
    cwd: process.cwd(),
    now: Date.now,
    ...(herdr
      ? {
          shutdown: createCodexRunShutdownVerifier({
            runtime: opened.runtime,
            provider: createHerdrCliProvider({
              executable: herdr,
              runner: nodeProcessRunner,
              endpoint: nodeHerdrEndpointReader,
            }),
            now: Date.now,
          }),
        }
      : {}),
    worktrees: {
      registry: opened.registry,
      store: opened.worktrees,
      git: createGitInspector({ executable, runner: nodeProcessRunner }),
      identity: nodeCheckoutIdentityReader,
      files: createNodeWorktreeFiles(managedRoot),
      effects: createWorktreeGit({ executable, runner: nodeProcessRunner }),
      managedRoot,
      now: Date.now,
      nextId: (kind) => `${kind}-${randomUUID()}`,
    },
  };
}

/** Offline effects hold kernel coordinator ownership before writable open/migration until all effects drain. */
export async function executeLocalCleanup(
  action: 'request' | 'execute' | 'reconcile' | 'control',
  input: unknown,
  options: { stateDirectory?: string; gitExecutable?: string; herdrExecutable?: string },
) {
  try {
    const prepared = await prepareStateDirectory(options.stateDirectory, false);
    const ownership = await acquireCoordinatorOwnership(prepared.root.path);

    try {
      const opened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: prepared.root.path,
      });

      if (opened.outcome !== 'opened') {
        return opened;
      }

      try {
        const git = await gitExecutable(options.gitExecutable);

        if (!git) {
          return rejected('git_unavailable', 'Select a trusted Git executable.');
        }

        const deps = composeCleanupDependencies(
          opened,
          git,
          await hostExecutable('herdr', options.herdrExecutable),
        );

        switch (action) {
          case 'request':
            return requestCleanup(input, deps);
          case 'execute':
            return await executeCleanup(input, deps);
          case 'reconcile':
            return await reconcileCleanup(input, deps);
          case 'control':
            return controlCleanup(input, deps);
        }
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
