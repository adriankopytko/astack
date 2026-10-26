import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { executeLocalCleanup } from '../host/cleanup.js';
import { inspectCleanup } from '../application/cleanup.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { requestLocalService } from '../adapters/local/service-client.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';

function number(value: string) {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError('Use a nonnegative safe integer.');
  }

  return Number(value);
}

function render(result: ServiceRpcResponse, json?: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  }

  if (
    'error' in result ||
    (result.value &&
      'worktreeId' in result.value &&
      'phase' in result.value &&
      ['blocked', 'started'].includes(String(result.value.phase)))
  ) {
    process.exitCode = 1;
  }
}

export function wireCleanupCommands(program: Command) {
  function host() {
    const options = program.opts<{
      stateDirectory?: string;
      gitExecutable?: string;
      herdrExecutable?: string;
    }>();

    return {
      ...options,
      ...(options.stateDirectory
        ? { stateDirectory: resolve(process.cwd(), options.stateDirectory) }
        : {}),
    };
  }

  async function write(
    action: 'request' | 'execute' | 'control' | 'reconcile',
    input: Record<string, unknown>,
    json?: boolean,
  ) {
    const options = host();
    let result: ServiceRpcResponse = await executeLocalCleanup(action, input, options);

    // Only intent/control operations use the running coordinator; offline effects never bypass its lock.
    if (
      result.outcome === 'rejected' &&
      result.error.code === 'service_already_running' &&
      (action === 'request' || action === 'control')
    ) {
      const state = await openSqliteState({
        schemaVersion: 1,
        mode: 'read-only',
        ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
      });

      if (state.outcome !== 'opened') {
        render(state, json);

        return;
      }

      try {
        result = await requestLocalService(state.stateDirectory, {
          ...input,
          operation: action === 'request' ? 'cleanup_request' : 'cleanup_control',
        });
      } finally {
        state.store.close();
      }
    }

    render(result, json);
  }

  const cleanup = program
    .command('cleanup')
    .description('Persist, execute, and reconcile owned checkout cleanup independently of review');
  cleanup
    .command('request <job-id>')
    .requiredOption('--key <key>', 'Stable intent key; one cleanup plan per run')
    .requiredOption(
      '--not-before <milliseconds>',
      'Earliest removal time as Unix milliseconds',
      number,
    )
    .option('--automatic', 'Allow service run --cleanup to execute this saved plan')
    .option(
      '--allow-unpublished',
      'Explicitly allow cleanup without confirmed publication; pending publication still blocks',
    )
    .option('--json')
    .action(
      async (
        jobId: string,
        options: {
          key: string;
          notBefore: number;
          automatic?: boolean;
          allowUnpublished?: boolean;
          json?: boolean;
        },
      ) => {
        await write(
          'request',
          {
            schemaVersion: 1,
            jobId,
            key: options.key,
            notBefore: options.notBefore,
            automatic: options.automatic ?? false,
            publication: options.allowUnpublished ? 'not_required' : 'required',
          },
          options.json,
        );
      },
    );
  cleanup
    .command('inspect <job-id>')
    .option('--json')
    .action(async (jobId: string, options: { json?: boolean }) => {
      const selected = host().stateDirectory;
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
          inspectCleanup({ schemaVersion: 1, jobId }, { cleanups: state.cleanups }),
          options.json,
        );
      } finally {
        state.store.close();
      }
    });
  cleanup
    .command('execute <job-id>')
    .description('Offline cleanup; optionally verify explicit host shutdown attestations first')
    .requiredOption('--revision <number>', 'Exact cleanup revision', number)
    .option('--attempt <id>', 'Exact source attempt for shutdown reconciliation')
    .option('--launch <id>', 'Exact native launch for shutdown reconciliation')
    .option(
      '--run-revision <number>',
      'Exact run control revision for shutdown reconciliation',
      number,
    )
    .option('--shutdown-key <key>', 'Stable run reconciliation key')
    .option('--worker-stopped', 'Host independently verified the worker and descendants stopped')
    .option('--services-stopped', 'Host independently verified associated services stopped')
    .option('--writers-stopped', 'Host stopped/excluded original controllers and descendants')
    .option('--json')
    .action(
      async (
        jobId: string,
        options: {
          revision: number;
          attempt?: string;
          launch?: string;
          runRevision?: number;
          shutdownKey?: string;
          workerStopped?: boolean;
          servicesStopped?: boolean;
          writersStopped?: boolean;
          json?: boolean;
        },
      ) => {
        const shutdown =
          options.attempt !== undefined ||
          options.launch !== undefined ||
          options.runRevision !== undefined ||
          options.shutdownKey !== undefined ||
          options.workerStopped ||
          options.servicesStopped ||
          options.writersStopped;
        await write(
          'execute',
          {
            schemaVersion: 1,
            jobId,
            expectedRevision: options.revision,
            ...(shutdown
              ? {
                  shutdown: {
                    schemaVersion: 1,
                    jobId,
                    key: options.shutdownKey,
                    attemptId: options.attempt,
                    launchId: options.launch,
                    expectedRevision: options.runRevision,
                    workerStopped: options.workerStopped,
                    servicesStopped: options.servicesStopped,
                    writersStopped: options.writersStopped,
                  },
                }
              : {}),
          },
          options.json,
        );
      },
    );
  cleanup
    .command('reconcile <job-id>')
    .description(
      'Offline inspect-only recovery after stopping the original cleanup writer and children',
    )
    .requiredOption('--revision <number>', 'Exact started cleanup revision', number)
    .requiredOption('--writers-stopped', 'Host stopped/excluded original writers and descendants')
    .option('--json')
    .action(
      async (
        jobId: string,
        options: { revision: number; writersStopped: boolean; json?: boolean },
      ) => {
        await write(
          'reconcile',
          {
            schemaVersion: 1,
            jobId,
            expectedRevision: options.revision,
            writersStopped: options.writersStopped,
          },
          options.json,
        );
      },
    );

  for (const action of ['suspend', 'resume', 'cancel'] as const) {
    cleanup
      .command(`${action} <job-id>`)
      .requiredOption('--revision <number>', 'Exact cleanup revision', number)
      .option('--json')
      .action(async (jobId: string, options: { revision: number; json?: boolean }) => {
        await write(
          'control',
          { schemaVersion: 1, jobId, expectedRevision: options.revision, action },
          options.json,
        );
      });
  }
}
