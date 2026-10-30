import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  verificationRequestSchema,
  verificationReconcileSchema,
  type VerificationRecord,
} from '../contracts/verification.js';
import {
  verifyImplementation,
  inspectImplementationVerification,
  reconcileImplementationVerification,
} from '../application/verification.js';
import type { OperationResult } from '../contracts/operation-result.js';
import { completed, rejected } from '../contracts/operation-result.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { prepareStateDirectory } from '../adapters/state/state-directory.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { nodeRunArtifactReader } from '../adapters/filesystem/run-artifacts.js';
import { gitExecutable } from '../core/host-git.js';
import { readRequestFile } from './request-file.js';
import { composeHookDependencies } from './hooks.js';
type Result =
  | Awaited<ReturnType<typeof verifyImplementation>>
  | OperationResult<VerificationRecord | null>;
function render(result: Result, json?: boolean, run = false) {
  process.stdout.write(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);

  if ('error' in result || (run && 'value' in result && result.value?.status !== 'passed')) {
    process.exitCode = 1;
  }
}

export function wireVerificationCommands(program: Command) {
  const command = program
    .command('verification')
    .description('Explicit executed implementation checks and durable publication evidence');
  const directory = () => {
    const selected = program.opts<{ stateDirectory?: string }>().stateDirectory;

    return selected === undefined ? undefined : resolve(process.cwd(), selected);
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
        render(
          inspectImplementationVerification(
            { schemaVersion: 1, id },
            { verifications: state.verifications },
          ),
          options.json,
        );
      } finally {
        state.store.close();
      }
    });

  for (const action of ['run', 'reconcile'] as const) {
    command
      .command(action)
      .requiredOption(
        '--file <path>',
        'Versioned bounded JSON request; no commands or passed claims',
      )
      .option('--json')
      .action(async (options: { file: string; json?: boolean }) => {
        let input: unknown;

        try {
          input = (
            action === 'run' ? verificationRequestSchema : verificationReconcileSchema
          ).parse(await readRequestFile(options.file, 16384));
        } catch {
          render(
            rejected('invalid_request', 'Select a valid bounded verification request file.'),
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
              if (action === 'reconcile') {
                render(
                  reconcileImplementationVerification(input, {
                    verifications: state.verifications,
                  }),
                  options.json,
                );

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
                await verifyImplementation(
                  input,
                  {
                    ...composeHookDependencies(state, executable),
                    verifications: state.verifications,
                    runs: state.runs,
                    artifacts: nodeRunArtifactReader,
                    workerInput: {
                      receipt: ({ attemptId, key }) => {
                        const result = state.runtime.action(attemptId, key);

                        if (result.outcome === 'rejected' || result.value === null) {
                          return result;
                        }

                        const action = result.value;

                        return action.kind === 'input'
                          ? completed({
                              key: action.key,
                              digest: action.digest,
                              state: action.state,
                            })
                          : rejected('runtime_conflict', 'Input key names a different action.');
                      },
                    },
                  },
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
