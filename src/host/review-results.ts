import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { createGhProvider } from '../adapters/github/provider.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { hostExecutable } from '../core/host-git.js';
import { rejected } from '../contracts/operation-result.js';
import {
  publishReviewResult,
  reconcileReviewPublication,
  observeReviewResult,
  type ReviewResultDependencies,
} from '../application/review-results.js';

/** Offline, explicit host capability only; never installed in the service dispatcher. */
export async function executeLocalReviewResult(
  input: unknown,
  options: {
    stateDirectory: string;
    mode: 'publish' | 'reconcile' | 'observe';
    gitExecutable?: string;
    githubExecutable?: string;
  },
) {
  try {
    const ownership = await acquireCoordinatorOwnership(options.stateDirectory);

    try {
      const state = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: options.stateDirectory,
      });

      if (state.outcome !== 'opened') {
        return state;
      }

      try {
        const git = await hostExecutable('git', options.gitExecutable);
        const gh = await hostExecutable('gh', options.githubExecutable);

        if (!git || !gh) {
          return rejected('github_unavailable', 'Select trusted Git and GitHub CLI executables.');
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

        const deps: ReviewResultDependencies = {
          registry: state.registry,
          git: createGitInspector({ executable: git, runner: nodeProcessRunner }),
          identity: nodeCheckoutIdentityReader,
          worktrees: state.worktrees,
          files: createNodeWorktreeFiles(join(state.stateDirectory, 'worktrees')),
          runs: state.runs,
          results: state.reviewResults,
          state: state.store,
          github: createGhProvider({
            executable: gh,
            runner: nodeProcessRunner,
            environment,
            now: Date.now,
            artifactParent: state.stateDirectory,
          }),
          now: Date.now,
          nextId: randomUUID,
        };

        return await (
          options.mode === 'publish'
            ? publishReviewResult
            : options.mode === 'reconcile'
              ? reconcileReviewPublication
              : observeReviewResult
        )(input, deps);
      } finally {
        state.store.close();
      }
    } finally {
      ownership.release();
    }
  } catch (error) {
    return stateRejection(error);
  }
}
