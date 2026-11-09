import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Command, InvalidArgumentError } from 'commander';
import { startLocalService } from '../host/local-service.js';
import { requestLocalService } from '../adapters/local/service-client.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';
import { inspectServiceJob } from '../application/service.js';
import { hostExecutable } from '../core/host-git.js';
import { requestStartingService } from './ensure-service.js';
import { readServiceSettings } from './service-settings.js';

function integer(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 64) {
    throw new InvalidArgumentError('Use an integer from 1 to 64.');
  }

  return Number(value);
}

function render(result: ServiceRpcResponse, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.outcome === 'rejected' || result.outcome === 'uncertain') {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else {
    const value = result.value;

    if (value === null) {
      process.stdout.write('Job not found.\n');
    } else if ('stopping' in value) {
      process.stdout.write('Service is stopping. Running agents are not stopped.\n');
    } else if ('sessionId' in value) {
      process.stdout.write(
        `Service: ${value.phase}\nSession: ${value.sessionId}\nRuntimes: ${value.runtimes.join(', ') || 'none installed'}\nJobs: ${JSON.stringify(value.counts)}\n`,
      );
    } else if ('cleanup' in value) {
      process.stdout.write(
        `Job: ${value.job.job.id}\nState: ${value.status}\nWorker: ${value.job.entry.state}\nCleanup: retained\n`,
      );
    } else if ('events' in value) {
      process.stdout.write(`Events: ${value.events.length}\nCursor: ${value.nextCursor}\n`);
    } else if ('consumer' in value) {
      process.stdout.write(`Consumer: ${value.consumer}\nCursor: ${value.after}\n`);
    } else if ('review' in value) {
      process.stdout.write(`Job: ${value.job.job.id}\nState: ${value.review.state}\n`);
    } else if ('implementation' in value) {
      process.stdout.write(`Job: ${value.job.job.id}\nState: ${value.implementation.state}\n`);
    } else if ('entry' in value) {
      process.stdout.write(
        `Job: ${value.job.id}\nAttempt: ${value.attempt.id}\nState: ${value.entry.state}\nReason: ${value.entry.reason ?? 'none'}\n`,
      );
    }
  }

  if (result.outcome === 'rejected' || result.outcome === 'uncertain') {
    process.exitCode = 1;
  }
}

export function wireServiceCommands(program: Command): void {
  const service = program
    .command('service')
    .description('Own a durable local queue through a private Unix socket');
  service
    .command('run')
    .description('Run the coordinator in the foreground')
    .option('--cleanup', 'Execute explicitly opted-in cleanup after verified shutdown')
    .option(
      '--after-handoff-review',
      'Enable the project-controlled follow-up executor; requires --observe-ci',
    )
    .option('--observe-ci', 'Enable bounded targeted CI observations for persisted requests')
    .option(
      '--codex-executable <absolute-path>',
      'Host Codex path; Herdr resolves its own Codex for project agents',
    )
    .option('--capacity <count>', 'Override global active/uncertain capacity', integer)
    .option('--role-capacity <count>', 'Override default capacity per agent', integer)
    .option('--json', 'Print the listening event as JSON')
    .action(
      async (options: {
        capacity?: number;
        roleCapacity?: number;
        observeCi?: boolean;
        afterHandoffReview?: boolean;
        cleanup?: boolean;
        codexExecutable?: string;
        json?: boolean;
      }) => {
        const host = program.opts<{
          stateDirectory?: string;
          gitExecutable?: string;
          herdrExecutable?: string;
        }>();
        const stateDirectory =
          host.stateDirectory === undefined
            ? join(homedir(), '.astack')
            : resolve(process.cwd(), host.stateDirectory);
        const settings = await readServiceSettings(stateDirectory);

        if (settings.outcome === 'rejected') {
          render(settings, options.json);

          return;
        }

        const herdr = await hostExecutable('herdr', host.herdrExecutable);
        const codex = await hostExecutable('codex', options.codexExecutable);
        const codexAvailable = Boolean(herdr && codex);
        const started = await startLocalService(
          {
            schemaVersion: 1,
            ...(host.stateDirectory === undefined
              ? {}
              : { stateDirectory: resolve(process.cwd(), host.stateDirectory) }),
            ...(host.gitExecutable === undefined ? {} : { gitExecutable: host.gitExecutable }),
            limits: {
              global: options.capacity ?? settings.value.concurrency?.global ?? 4,
              defaultRole: options.roleCapacity ?? settings.value.concurrency?.perAgent ?? 4,
              perRole: {},
            },
          },
          {
            ...(options.observeCi ? { ci: {} } : {}),
            afterHandoffReview: options.afterHandoffReview ?? false,
            cleanup: options.cleanup ?? false,
            ...(host.herdrExecutable ? { cleanupHerdrExecutable: host.herdrExecutable } : {}),
            ...(codexAvailable
              ? {
                  codexHerdr: {
                    herdrExecutable: herdr!,
                    codexExecutable: codex!,
                  },
                }
              : {}),
          },
        );

        if (started.outcome !== 'listening') {
          render(started, options.json);

          return;
        }

        const stop = () => {
          void started.close();
        };

        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        process.stdout.write(
          options.json
            ? `${JSON.stringify({ schemaVersion: 1, outcome: 'listening', sessionId: started.sessionId, socketPath: started.socketPath })}\n`
            : `Service listening at ${started.socketPath}\nRuntimes: ${codexAvailable ? 'codex-herdr' : 'Codex unavailable (install Codex and Herdr, then restart the service)'}.\nCI observations: ${options.observeCi ? 'enabled' : 'disabled'}.\nAfter-handoff executor: ${options.afterHandoffReview ? 'enabled' : 'disabled'}.\nCleanup executor: ${options.cleanup ? 'enabled' : 'disabled'}.\n`,
        );

        try {
          const result = await started.closed;

          if (result.outcome === 'rejected') {
            process.stderr.write(`${result.error.message}\n`);
            process.exitCode = 1;
          }
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
      },
    );

  async function request(input: unknown, json?: boolean, inspectId?: string): Promise<void> {
    const host = program.opts<{
      stateDirectory?: string;
      gitExecutable?: string;
      herdrExecutable?: string;
    }>();
    const opened = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      ...(host.stateDirectory === undefined
        ? {}
        : { stateDirectory: resolve(process.cwd(), host.stateDirectory) }),
    });

    if (opened.outcome !== 'opened') {
      render(opened, json);

      return;
    }

    try {
      render(
        inspectId === undefined
          ? typeof input === 'object' &&
            input !== null &&
            'operation' in input &&
            (input.operation === 'status' || input.operation === 'stop')
            ? await requestLocalService(opened.stateDirectory, input)
            : await requestStartingService(opened.stateDirectory, input, host)
          : inspectServiceJob({ schemaVersion: 1, jobId: inspectId }, opened.service),
        json,
      );
    } finally {
      opened.store.close();
    }
  }

  for (const operation of ['status', 'wake', 'stop'] as const) {
    service
      .command(operation)
      .description(
        operation === 'status'
          ? 'Inspect the live local coordinator'
          : operation === 'stop'
            ? 'Stop the coordinator without stopping agents'
            : 'Request fresh reconciliation and queue dispatch',
      )
      .option('--json', 'Print structured evidence')
      .action(async (options: { json?: boolean }) => {
        await request({ schemaVersion: 1, operation }, options.json);
      });
  }

  service
    .command('inspect <job-id>')
    .description('Read a durable job without contacting providers')
    .option('--json', 'Print the saved job, attempt and effect')
    .action(async (jobId: string, options: { json?: boolean }) => {
      await request({ schemaVersion: 1, operation: 'inspect', jobId }, options.json, jobId);
    });
  service
    .command('submit')
    .description(
      'Persist a generic request; enabled runtimes may launch a session without delivering the task',
    )
    .requiredOption('--project <id>', 'Explicit registered project ID')
    .option('--checkout <id>', 'Registered target checkout; default: primary')
    .requiredOption('--role <name>', 'Approved role')
    .requiredOption('--key <key>', 'Stable idempotency key for this project and role')
    .requiredOption('--branch <branch>', 'Expected target branch')
    .requiredOption('--commit <sha>', 'Expected full target commit')
    .requiredOption('--task <text>', 'Task description without credentials')
    .option('--json', 'Print the durable acceptance receipt')
    .action(
      async (options: {
        project: string;
        checkout?: string;
        role: string;
        key: string;
        branch: string;
        commit: string;
        task: string;
        json?: boolean;
      }) => {
        await request(
          {
            schemaVersion: 1,
            operation: 'submit',
            projectId: options.project,
            role: options.role,
            ...(options.checkout === undefined ? {} : { checkoutId: options.checkout }),
            key: options.key,
            branch: options.branch.startsWith('refs/')
              ? options.branch
              : `refs/heads/${options.branch}`,
            commit: options.commit,
            task: { description: options.task },
          },
          options.json,
        );
      },
    );
}
