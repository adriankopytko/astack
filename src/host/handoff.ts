import { createNodeConfigurationReader } from '../adapters/filesystem/configuration.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { createGitPublisher } from '../adapters/git/publisher.js';
import { createGhProvider } from '../adapters/github/provider.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { nodeRunArtifactReader } from '../adapters/filesystem/run-artifacts.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { hostExecutable } from '../core/host-git.js';
import { completed, rejected } from '../contracts/operation-result.js';
import {
  finishImplementation,
  reconcileImplementationHandoff,
  type HandoffDependencies,
} from '../application/handoff.js';

/** Explicit offline host path. Writer exclusion precedes opening/migrating state. */
export async function executeLocalHandoff(
  input: unknown,
  options: {
    stateDirectory: string;
    mode: 'finish' | 'reconcile';
    gitExecutable?: string;
    githubExecutable?: string;
  },
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
        const git = await hostExecutable('git', options.gitExecutable);
        const gh = await hostExecutable('gh', options.githubExecutable);

        if (!git || !gh) {
          return rejected('handoff_blocked', 'Select trusted Git and GitHub CLI executables.');
        }

        const environment: Record<string, string> = {};

        for (const key of [
          'HOME',
          'PATH',
          'GH_CONFIG_DIR',
          'GH_TOKEN',
          'GITHUB_TOKEN',
          'GH_ENTERPRISE_TOKEN',
          'GITHUB_ENTERPRISE_TOKEN',
          'SSL_CERT_FILE',
          'SSL_CERT_DIR',
        ]) {
          const value = process.env[key];

          if (value !== undefined) {
            environment[key] = value;
          }
        }

        const deps: HandoffDependencies = {
          registry: opened.registry,
          git: createGitInspector({ executable: git, runner: nodeProcessRunner }),
          identity: nodeCheckoutIdentityReader,
          worktrees: opened.worktrees,
          files: createNodeWorktreeFiles(join(opened.stateDirectory, 'worktrees')),
          runs: opened.runs,
          state: opened.store,
          handoffs: opened.handoffs,
          verifications: opened.verifications,
          configuration: createNodeConfigurationReader(opened.stateDirectory),
          artifacts: nodeRunArtifactReader,
          workerInput: {
            receipt({ attemptId, key }) {
              const result = opened.runtime.action(attemptId, key);

              if (result.outcome === 'rejected' || result.value === null) {
                return result;
              }

              const action = result.value;

              return action.kind === 'input'
                ? completed({ key: action.key, digest: action.digest, state: action.state })
                : rejected('runtime_conflict', 'Input key identifies a different action.');
            },
          },
          publisher: createGitPublisher({
            executable: git,
            githubExecutable: gh,
            runner: nodeProcessRunner,
            environment,
            now: Date.now,
          }),
          github: createGhProvider({
            executable: gh,
            runner: nodeProcessRunner,
            environment,
            now: Date.now,
            artifactParent: opened.stateDirectory,
          }),
          now: Date.now,
          nextId: randomUUID,
        };

        return await (
          options.mode === 'finish' ? finishImplementation : reconcileImplementationHandoff
        )(input, deps);
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
