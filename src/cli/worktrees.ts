import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  prepareWorktree,
  inspectWorktree,
  removeWorktree,
  reconcileWorktree,
} from '../application/worktrees.js';
import type { WorktreeDependencies } from '../application/worktree-evidence.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { createWorktreeGit } from '../adapters/git/worktree-git.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { rejected } from '../contracts/operation-result.js';
import type { WorktreeResult } from '../contracts/worktrees.js';
import { gitExecutable } from './projects.js';

function render(result: WorktreeResult, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else {
    process.stdout.write(
      `Outcome: ${result.outcome}\nWorktree: ${result.record.intent.id}\nCheckout: ${result.record.intent.checkoutId}\nRoot: ${result.record.intent.checkoutPath}\nPhase: ${result.record.phase}\nOperation: ${result.record.operationId}\n`,
    );

    if ('reason' in result) {
      process.stdout.write(`Reason: ${result.reason}\n`);
    }
  }

  if (['blocked', 'pending', 'rejected', 'uncertain'].includes(result.outcome)) {
    process.exitCode = 1;
  }
}

async function execute(
  program: Command,
  writable: boolean,
  json: boolean | undefined,
  action: (dependencies: WorktreeDependencies) => Promise<WorktreeResult>,
): Promise<void> {
  const host = program.opts<{ stateDirectory?: string; gitExecutable?: string }>();
  const opened = await openSqliteState({
    schemaVersion: 1,
    mode: writable ? 'read-write' : 'read-only',
    ...(host.stateDirectory === undefined
      ? {}
      : { stateDirectory: resolve(process.cwd(), host.stateDirectory) }),
  });

  if (opened.outcome !== 'opened') {
    render(
      !writable && opened.error.code === 'state_not_found'
        ? rejected('worktree_not_found', 'No owned worktree state exists.')
        : opened,
      json,
    );

    return;
  }

  try {
    const executable = await gitExecutable(host.gitExecutable);

    if (!executable) {
      render(
        rejected('git_unavailable', 'Select an absolute Git executable or add Git to PATH.'),
        json,
      );

      return;
    }

    const managedRoot = join(opened.stateDirectory, 'worktrees');
    const dependencies: WorktreeDependencies = {
      registry: opened.registry,
      store: opened.worktrees,
      git: createGitInspector({ executable, runner: nodeProcessRunner }),
      effects: createWorktreeGit({ executable, runner: nodeProcessRunner }),
      identity: nodeCheckoutIdentityReader,
      files: createNodeWorktreeFiles(managedRoot),
      managedRoot,
      now: Date.now,
      nextId: (kind) => `${kind}-${randomUUID()}`,
    };
    render(await action(dependencies), json);
  } finally {
    if (opened.store.close().outcome === 'rejected') {
      process.stderr.write('State connection cleanup failed; inspect state before retrying.\n');
      process.exitCode = 1;
    }
  }
}

export function wireWorktreeCommands(program: Command): void {
  const worktree = program
    .command('worktree')
    .description('Prepare, inspect, reconcile, and remove owned checkouts');
  worktree
    .command('prepare')
    .description('Create or verify an isolated checkout at an explicit full commit SHA')
    .requiredOption('--project <id>', 'Registered project ID')
    .option('--checkout <id>', 'Registered source checkout; default: project primary')
    .option('--run <attempt-id>', 'Bind to an existing saved attempt assignment')
    .requiredOption('--key <key>', 'Stable owner key within this project')
    .requiredOption('--branch <branch>', 'New task branch name or full refs/heads name')
    .requiredOption('--base <sha>', 'Full local commit SHA')
    .option('--json', 'Print structured lifecycle evidence')
    .action(
      async (options: {
        project: string;
        checkout?: string;
        run?: string;
        key: string;
        branch: string;
        base: string;
        json?: boolean;
      }) => {
        await execute(program, true, options.json, (dependencies) =>
          prepareWorktree(
            {
              schemaVersion: 1,
              projectId: options.project,
              key: options.key,
              branch: options.branch.startsWith('refs/')
                ? options.branch
                : `refs/heads/${options.branch}`,
              baseCommit: options.base,
              ...(options.checkout === undefined ? {} : { checkoutId: options.checkout }),
              ...(options.run === undefined ? {} : { runId: options.run }),
            },
            dependencies,
          ),
        );
      },
    );
  worktree
    .command('inspect <id>')
    .description('Observe an owned worktree without changing it')
    .option('--json', 'Print structured lifecycle evidence')
    .action(async (id: string, options: { json?: boolean }) => {
      await execute(program, false, options.json, (dependencies) =>
        inspectWorktree({ schemaVersion: 1, id }, dependencies),
      );
    });
  worktree
    .command('remove <id>')
    .description('Remove a verified clean owned checkout while preserving its task branch')
    .option('--json', 'Print structured lifecycle evidence')
    .action(async (id: string, options: { json?: boolean }) => {
      await execute(program, true, options.json, (dependencies) =>
        removeWorktree({ schemaVersion: 1, id }, dependencies),
      );
    });
  worktree
    .command('reconcile <id>')
    .description(
      'Settle interrupted state after the host confirms the previous writer and children stopped',
    )
    .requiredOption('--operation <operation-id>', 'Exact pending operation ID from inspection')
    .requiredOption(
      '--writer-stopped',
      'Host attestation that the previous writer and its children have stopped',
    )
    .option('--json', 'Print structured lifecycle evidence')
    .action(
      async (
        id: string,
        options: { operation: string; writerStopped: boolean; json?: boolean },
      ) => {
        await execute(program, true, options.json, (dependencies) =>
          reconcileWorktree(
            {
              schemaVersion: 1,
              id,
              operationId: options.operation,
              writerStopped: options.writerStopped,
            },
            dependencies,
          ),
        );
      },
    );
}
