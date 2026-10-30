import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  hookRequestSchema,
  hookReconcileSchema,
  hookExcludeSchema,
  type HookRecord,
} from '../contracts/hooks.js';
import {
  executeHook,
  inspectHook,
  reconcileHook,
  excludeHookWriter,
  type HookDependencies,
} from '../application/hooks.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { prepareStateDirectory } from '../adapters/state/state-directory.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import {
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
} from '../adapters/filesystem/configuration.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { nodeHookEnvironment } from '../adapters/filesystem/hook-environment.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { nodePortProbe } from '../adapters/network/port-probe.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { gitExecutable } from '../core/host-git.js';
import { readRequestFile } from './request-file.js';
type Opened = Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>;
export function composeHookDependencies(state: Opened, executable: string): HookDependencies {
  return {
    hooks: state.hooks,
    queue: state.service,
    allocations: state.allocations,
    ports: nodePortProbe,
    registry: state.registry,
    git: createGitInspector({ executable, runner: nodeProcessRunner }),
    identity: nodeCheckoutIdentityReader,
    worktrees: state.worktrees,
    files: createNodeWorktreeFiles(join(state.stateDirectory, 'worktrees')),
    configuration: createNodeConfigurationReader(state.stateDirectory),
    prerequisites: createNodeConfigurationProbe(
      (name) => Object.hasOwn(process.env, name) && Boolean(process.env[name]),
    ),
    runner: nodeProcessRunner,
    environment: nodeHookEnvironment,
    now: Date.now,
  };
}

type Result = Awaited<ReturnType<typeof executeHook>> | OperationResult<HookRecord | null>;
function render(result: Result, json?: boolean, executing = false) {
  process.stdout.write(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);

  if (
    'error' in result ||
    (executing && 'value' in result && result.value && result.value.status !== 'succeeded')
  ) {
    process.exitCode = 1;
  }
}

export function wireHookCommands(program: Command) {
  const command = program
    .command('hooks')
    .description(
      'Explicit host-approved lifecycle execution and durable evidence; never replay claimed commands',
    );
  const directory = () => {
    const value = program.opts<{ stateDirectory?: string }>().stateDirectory;

    return value === undefined ? undefined : resolve(process.cwd(), value);
  };

  command
    .command('inspect <id>')
    .option('--json')
    .action(async (id: string, options: { json?: boolean }) => {
      const selected = directory();
      const state = await openSqliteState({
        schemaVersion: 1,
        mode: 'read-only',
        ...(selected ? { stateDirectory: selected } : {}),
      });

      if (state.outcome !== 'opened') {
        render(state, options.json);

        return;
      }

      try {
        render(inspectHook({ schemaVersion: 1, id }, { hooks: state.hooks }), options.json);
      } finally {
        state.store.close();
      }
    });

  for (const action of ['execute', 'reconcile', 'exclude-writer'] as const) {
    command
      .command(action)
      .requiredOption(
        '--file <path>',
        'Bounded versioned JSON request; no environment values or command text',
      )
      .option('--json')
      .action(async (options: { file: string; json?: boolean }) => {
        let input: unknown;

        try {
          input = (
            action === 'execute'
              ? hookRequestSchema
              : action === 'exclude-writer'
                ? hookExcludeSchema
                : hookReconcileSchema
          ).parse(await readRequestFile(options.file, 16384));
        } catch {
          render(
            rejected('invalid_request', 'Select a valid bounded hook request file.'),
            options.json,
          );

          return;
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once('SIGINT', abort);
        process.once('SIGTERM', abort);

        try {
          const prepared = await prepareStateDirectory(directory(), true);
          const ownership = await acquireCoordinatorOwnership(prepared.root.path);

          try {
            const state = await openSqliteState({
              schemaVersion: 1,
              stateDirectory: prepared.root.path,
            });

            if (state.outcome !== 'opened') {
              render(state, options.json);

              return;
            }

            try {
              if (action === 'exclude-writer') {
                render(excludeHookWriter(input, { hooks: state.hooks }), options.json);

                return;
              }

              if (action === 'reconcile') {
                render(reconcileHook(input, { hooks: state.hooks }), options.json);

                return;
              }

              const executable = await gitExecutable(
                program.opts<{ gitExecutable?: string }>().gitExecutable,
              );

              if (!executable) {
                render(
                  rejected('git_unavailable', 'Select a trusted Git executable.'),
                  options.json,
                );

                return;
              }

              render(
                await executeHook(
                  input,
                  composeHookDependencies(state, executable),
                  controller.signal,
                ),
                options.json,
                true,
              );
            } finally {
              state.store.close();
            }
          } finally {
            ownership.release();
          }
        } catch (error) {
          render(stateRejection(error), options.json);
        } finally {
          process.removeListener('SIGINT', abort);
          process.removeListener('SIGTERM', abort);
        }
      });
  }
}
