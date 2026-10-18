import { resolve } from 'node:path';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { requestLocalService } from '../adapters/local/service-client.js';
import { nodeRunEventWaiter } from '../adapters/local/run-waiter.js';
import { inspectRun, readRunEvents, readRunCursor } from '../application/runs.js';
import { rejected } from '../contracts/operation-result.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';
function number(value: string): number {
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
  } else if (result.value === null) {
    process.stdout.write('Run not found.\n');
  } else if ('cleanup' in result.value) {
    const value = result.value;
    process.stdout.write(
      `Job: ${value.job.job.id}\nAttempt: ${value.job.attempt.id}\nState: ${value.status}\nWorker: ${value.job.entry.state}\nReport: ${value.control.reportId ?? 'none'}\nBlocker: ${value.job.entry.readiness?.message ?? value.job.entry.reason ?? 'none'}\nCleanup: retained\n`,
    );
  } else if ('events' in result.value) {
    for (const event of result.value.events) {
      process.stdout.write(
        `${event.id} ${event.jobId} ${event.kind} ${JSON.stringify(event.detail)}\n`,
      );
    }

    process.stdout.write(`Cursor: ${result.value.nextCursor}\n`);
  } else if ('consumer' in result.value) {
    process.stdout.write(`Consumer: ${result.value.consumer}\nCursor: ${result.value.after}\n`);
  }

  if (
    'error' in result ||
    (result.value &&
      'cleanup' in result.value &&
      ['unknown', 'blocked', 'failed', 'needs_decision'].includes(result.value.status))
  ) {
    process.exitCode = 1;
  }
}

export function wireRunCommands(program: Command) {
  const run = program
    .command('run')
    .description('Inspect durable results/events and explicitly respond, resume or cancel');
  async function execute(
    json: boolean | undefined,
    action: (
      state: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>,
    ) => Promise<ServiceRpcResponse>,
  ) {
    const options = program.opts<{ stateDirectory?: string }>();
    const state = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      ...(options.stateDirectory === undefined
        ? {}
        : { stateDirectory: resolve(process.cwd(), options.stateDirectory) }),
    });

    if (state.outcome !== 'opened') {
      render(state, json);

      return;
    }

    try {
      render(await action(state), json);
    } finally {
      state.store.close();
    }
  }

  run
    .command('inspect <job-id>')
    .option('--json')
    .action(async (jobId: string, options: { json?: boolean }) => {
      await execute(options.json, async (state) =>
        inspectRun({ schemaVersion: 1, jobId }, { runs: state.runs }),
      );
    });
  run
    .command('report <job-id>')
    .description(
      'Validate and accept a host-supplied worker report; never read arbitrary terminal transcripts',
    )
    .requiredOption('--key <key>', 'Stable report acceptance key')
    .requiredOption('--file <path>', 'Bounded JSON proposal or {proposal, artifacts} envelope')
    .option('--json')
    .action(async (jobId: string, options: { key: string; file: string; json?: boolean }) => {
      await execute(options.json, async (state) => {
        try {
          const path = resolve(process.cwd(), options.file);
          const info = await lstat(path, { bigint: true });

          if (!info.isFile() || info.isSymbolicLink() || info.size > 48000n) {
            return rejected('invalid_request', 'Select a regular bounded report JSON file.');
          }

          const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          let content: Buffer;

          try {
            const bytes = Buffer.alloc(48001);
            let size = 0;

            while (size < bytes.length) {
              const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);

              if (bytesRead === 0) {
                break;
              }

              size += bytesRead;
            }

            const after = await file.stat({ bigint: true });

            if (
              size > 48000 ||
              after.dev !== info.dev ||
              after.ino !== info.ino ||
              after.size !== info.size ||
              after.mtimeNs !== info.mtimeNs ||
              after.ctimeNs !== info.ctimeNs
            ) {
              return rejected(
                'invalid_request',
                'Report changed or exceeded the bounded input contract.',
              );
            }

            content = bytes.subarray(0, size);
          } finally {
            await file.close();
          }

          const value: unknown = JSON.parse(
            new TextDecoder('utf8', { fatal: true }).decode(content),
          );
          const envelope =
            value && typeof value === 'object' && 'proposal' in value
              ? (value as { proposal: unknown; artifacts?: unknown })
              : { proposal: value };

          return requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'run_report',
            jobId,
            key: options.key,
            proposal: envelope.proposal,
            artifacts: envelope.artifacts ?? [],
          });
        } catch {
          return rejected('invalid_request', 'Report file could not be read as bounded JSON.');
        }
      });
    });
  run
    .command('respond <job-id>')
    .description('Save a decision response without sending worker input')
    .requiredOption('--key <key>')
    .requiredOption('--decision <report-id>')
    .requiredOption('--text <text>')
    .option('--json')
    .action(
      async (
        jobId: string,
        options: { key: string; decision: string; text: string; json?: boolean },
      ) => {
        await execute(options.json, (state) =>
          requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'run_respond',
            jobId,
            key: options.key,
            decisionId: options.decision,
            text: options.text,
          }),
        );
      },
    );
  run
    .command('resume <job-id>')
    .description(
      'Authorize a recorded continuation in the existing verified worker; never launch a replacement',
    )
    .requiredOption('--key <key>')
    .requiredOption('--response <response-id>')
    .option('--json')
    .action(async (jobId: string, options: { key: string; response: string; json?: boolean }) => {
      await execute(options.json, (state) =>
        requestLocalService(state.stateDirectory, {
          schemaVersion: 1,
          operation: 'run_resume',
          jobId,
          key: options.key,
          responseId: options.response,
        }),
      );
    });
  run
    .command('cancel <job-id>')
    .description(
      'Persist cancellation before any optional verified-session interrupt; preserve all work',
    )
    .requiredOption('--key <key>')
    .option('--interrupt', 'Request a keyed Escape only in a verified owned session')
    .option('--json')
    .action(
      async (jobId: string, options: { key: string; interrupt?: boolean; json?: boolean }) => {
        await execute(options.json, (state) =>
          requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'run_cancel',
            jobId,
            key: options.key,
            interrupt: options.interrupt ?? false,
          }),
        );
      },
    );
  run
    .command('events')
    .description(
      'Read or wait for local durable events, without GitHub polling or worker prompt injection',
    )
    .option('--project <id>')
    .option('--job <id>')
    .option('--after <id>', 'Exclusive global event ID', number)
    .option('--consumer <id>', 'Read the saved cursor; does not acknowledge events')
    .option('--limit <count>', 'Page size 1–100', number, 50)
    .option('--wait <ms>', 'Bounded local wait, at most 20000 ms', number, 0)
    .option('--json')
    .action(
      async (options: {
        project?: string;
        job?: string;
        after?: number;
        consumer?: string;
        limit: number;
        wait: number;
        json?: boolean;
      }) => {
        await execute(options.json, async (state) => {
          const scope = {
            ...(options.project === undefined ? {} : { projectId: options.project }),
            ...(options.job === undefined ? {} : { jobId: options.job }),
          };
          let after = options.after ?? 0;

          if (options.consumer) {
            if (options.after !== undefined) {
              return rejected('invalid_request', 'Use either --after or --consumer.');
            }

            const cursor = readRunCursor(
              { schemaVersion: 1, ...scope, consumer: options.consumer },
              { runs: state.runs },
            );

            if (cursor.outcome === 'rejected') {
              return cursor;
            }

            after = cursor.value.after;
          }

          return readRunEvents(
            { schemaVersion: 1, ...scope, after, limit: options.limit, waitMs: options.wait },
            { runs: state.runs, now: () => performance.now(), waiter: nodeRunEventWaiter },
          );
        });
      },
    );
  const cursor = run
    .command('cursor')
    .description('Inspect or explicitly acknowledge a scope-specific consumer cursor');
  cursor
    .command('inspect <consumer>')
    .option('--project <id>')
    .option('--job <id>')
    .option('--json')
    .action(
      async (consumer: string, options: { project?: string; job?: string; json?: boolean }) => {
        await execute(options.json, async (state) =>
          readRunCursor(
            {
              schemaVersion: 1,
              consumer,
              ...(options.project === undefined ? {} : { projectId: options.project }),
              ...(options.job === undefined ? {} : { jobId: options.job }),
            },
            { runs: state.runs },
          ),
        );
      },
    );
  cursor
    .command('ack <consumer>')
    .requiredOption('--expected <id>', 'Previously acknowledged offset', number)
    .requiredOption('--after <id>', 'Processed page cursor', number)
    .option('--project <id>')
    .option('--job <id>')
    .option('--json')
    .action(
      async (
        consumer: string,
        options: {
          expected: number;
          after: number;
          project?: string;
          job?: string;
          json?: boolean;
        },
      ) => {
        await execute(options.json, (state) =>
          requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'run_checkpoint',
            consumer,
            expected: options.expected,
            after: options.after,
            ...(options.project === undefined ? {} : { projectId: options.project }),
            ...(options.job === undefined ? {} : { jobId: options.job }),
          }),
        );
      },
    );
}
