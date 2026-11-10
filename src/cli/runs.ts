import { collectRunReport } from '../application/report-collection.js';
import { createCodexReportReader } from '../adapters/codex/report-reader.js';
import { reconcileLocalQueuedWorker, reconcileLocalRun } from '../host/reconcile-run.js';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { requestStartingService } from './ensure-service.js';
import { nodeRunEventWaiter } from '../adapters/local/run-waiter.js';
import { inspectRun, readRunEvents, readRunCursor } from '../application/runs.js';
import { rejected } from '../contracts/operation-result.js';
import { inspectQueuedWorker } from '../application/inspect-worker-queue.js';
import { renderQueuedWorker } from './render-queued-worker.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';
import { createHash } from 'node:crypto';
import { canonicalFileRoot, readRegularFile } from '../core/file-paths.js';
import { genericHandoffTask } from '../application/generic-handoff.js';
function number(value: string): number {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError('Use a nonnegative safe integer.');
  }

  return Number(value);
}

function render(result: ServiceRpcResponse, json?: boolean, submittedReport = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else if (result.value === null) {
    process.stdout.write('Run not found.\n');
  } else if ('request' in result.value && 'state' in result.value) {
    process.stdout.write(renderQueuedWorker(result.value));
  } else if ('cleanup' in result.value) {
    const value = result.value;
    const status = value.status === 'needs_decision' ? 'needs-input' : value.status;
    process.stdout.write(
      `Job: ${value.job.job.id}\nAttempt: ${value.job.attempt.id}\nState: ${status}\nWorker: ${value.job.entry.state}\nReport: ${value.control.reportId ?? 'none'}\nBlocker: ${value.job.entry.readiness?.message ?? value.job.entry.reason ?? 'none'}\nCleanup: ${value.cleanup.state} (${value.cleanup.retainedResourceCount} holds)\n`,
    );

    if (value.report) {
      process.stdout.write(`Summary: ${value.report.request.proposal.summary}\n`);
      const task = genericHandoffTask(value.job);

      for (const artifact of value.report.request.artifacts) {
        process.stdout.write(
          `Artifact: ${task ? join(task.root, artifact.path) : artifact.path}\n`,
        );
      }
    }

    for (const resource of value.cleanup.resources) {
      if (resource.hookOutcome) {
        process.stdout.write(`${resource.kind}: ${resource.hookOutcome}\n`);
      }
    }
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
      'request' in result.value &&
      'state' in result.value &&
      !!result.value.error) ||
    (!submittedReport &&
      result.value &&
      'cleanup' in result.value &&
      ['unknown', 'blocked', 'failed', 'needs_decision'].includes(result.value.status))
  ) {
    process.exitCode = 1;
  }
}

export function wireRunCommands(program: Command) {
  const requestLocalService = (stateDirectory: string, request: unknown) =>
    requestStartingService(
      stateDirectory,
      request,
      program.opts<{ gitExecutable?: string; herdrExecutable?: string }>(),
    );
  const run = program
    .command('run')
    .description('Inspect durable results/events and explicitly respond, resume or cancel');
  async function execute(
    json: boolean | undefined,
    action: (
      state: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>,
    ) => Promise<ServiceRpcResponse>,
    submittedReport = false,
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
      render(await action(state), json, submittedReport);
    } finally {
      state.store.close();
    }
  }

  run
    .command('inspect <job-id>')
    .option('--json')
    .action(async (jobId: string, options: { json?: boolean }) => {
      await execute(options.json, async (state) => {
        const queued = inspectQueuedWorker(jobId, state.workerQueue, state.worktrees);

        if (queued.outcome === 'rejected') {
          return queued;
        }

        if (queued.value && !queued.value.jobId) {
          return queued;
        }

        return inspectRun(
          { schemaVersion: 1, jobId: queued.value?.jobId ?? jobId },
          { runs: state.runs },
        );
      });
    });
  run
    .command('finish <job-id>')
    .description('Record a generic agent result')
    .requiredOption('--status <status>', 'completed, needs-input, or failed')
    .requiredOption('--summary <text>', 'Result summary')
    .option(
      '--artifact <relative-path>',
      'Attach a result file from the checkout; repeatable',
      (value: string, values: string[]) => [...values, value],
      [],
    )
    .option('--json')
    .action(
      async (
        jobId: string,
        options: { status: string; summary: string; artifact: string[]; json?: boolean },
      ) => {
        await execute(
          options.json,
          async (state) => {
            if (!['completed', 'needs-input', 'failed'].includes(options.status)) {
              return rejected('invalid_request', 'Choose completed, needs-input, or failed.');
            }

            const selected = inspectRun({ schemaVersion: 1, jobId }, { runs: state.runs });

            if (selected.outcome === 'rejected') {
              return selected;
            }

            if (!selected.value) {
              return rejected('state_not_found', 'Run not found.');
            }

            const job = selected.value.job;
            const task = genericHandoffTask(job);

            if (!task || options.artifact.length > 8) {
              return rejected(
                'invalid_request',
                'Select a generic handoff and at most eight result files.',
              );
            }

            const artifacts = [];

            try {
              const root = await canonicalFileRoot(task.root);

              for (const path of options.artifact) {
                const file = await readRegularFile(root, path, 4 * 1024 * 1024);

                if (!file) {
                  return rejected(
                    'invalid_request',
                    'A result file does not exist in the checkout.',
                  );
                }

                artifacts.push({ path, digest: file.sha256, size: file.bytes.length });
              }
            } catch {
              return rejected(
                'invalid_request',
                'A result file is unavailable, unsafe or too large.',
              );
            }

            const outcome = options.status === 'needs-input' ? 'needs_decision' : options.status;
            const proposal = {
              schemaVersion: 1,
              jobId,
              attemptId: job.attempt.id,
              projectId: job.job.projectId,
              checkoutId: job.job.checkoutId,
              outcome,
              summary: options.summary,
              blockers: [],
            };
            const round =
              selected.value.resumes.find((resume) => resume.state === 'acknowledged')?.id ??
              'initial';
            const key = `finish-${createHash('sha256').update(JSON.stringify({ round, proposal, artifacts })).digest('hex')}`;

            return requestLocalService(state.stateDirectory, {
              schemaVersion: 1,
              operation: 'run_report',
              jobId,
              key,
              proposal,
              artifacts,
            });
          },
          true,
        );
      },
    );
  run
    .command('report <job-id>')
    .description(
      'Validate and accept a host-supplied worker report; never read arbitrary terminal transcripts',
    )
    .requiredOption('--key <key>', 'Stable report acceptance key')
    .option('--file <path>', 'Bounded JSON proposal or {proposal, artifacts} envelope')
    .option('--stdin', 'Read the JSON proposal from standard input')
    .option('--json')
    .action(
      async (
        jobId: string,
        options: {
          key: string;
          file?: string;
          stdin?: boolean;
          json?: boolean;
        },
      ) => {
        await execute(
          options.json,
          async (state) => {
            try {
              if (Boolean(options.file) === Boolean(options.stdin)) {
                return rejected('invalid_request', 'Select exactly one of --file or --stdin.');
              }

              let content: Buffer;

              if (options.stdin) {
                const chunks: Buffer[] = [];
                let size = 0;

                for await (const bytes of process.stdin as AsyncIterable<Buffer>) {
                  size += bytes.length;

                  if (size > 48000) {
                    return rejected('invalid_request', 'Report input exceeds the size limit.');
                  }

                  chunks.push(bytes);
                }

                content = Buffer.concat(chunks);
              } else {
                const path = resolve(process.cwd(), options.file!);
                const info = await lstat(path, { bigint: true });

                if (!info.isFile() || info.isSymbolicLink() || info.size > 48000n) {
                  return rejected('invalid_request', 'Select a regular bounded report JSON file.');
                }

                const file = await open(
                  path,
                  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                );

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
          },
          true,
        );
      },
    );
  run
    .command('collect-report <job-id>')
    .description(
      'Collect the final structured report from an explicitly selected local Codex JSONL session and validate it with the coordinator',
    )
    .requiredOption('--key <key>')
    .requiredOption(
      '--session-file <path>',
      'Host-selected Codex session file; never automatically search transcripts',
    )
    .option('--json')
    .action(
      async (jobId: string, options: { key: string; sessionFile: string; json?: boolean }) => {
        await execute(options.json, async (state) => {
          const selected = state.runs.inspect(jobId);

          if (selected.outcome === 'rejected') {
            return selected;
          }

          if (!selected.value) {
            return rejected('run_not_found', 'Run not found.');
          }

          const session = state.runtime.read(selected.value.job.attempt.id);

          if (session.outcome === 'rejected') {
            return session;
          }

          if (!session.value) {
            return rejected('runtime_unavailable', 'No saved Codex runtime session exists.');
          }

          const result = await collectRunReport(
            { schemaVersion: 1, jobId, key: options.key },
            {
              runs: state.runs,
              reports: createCodexReportReader({
                file: resolve(process.cwd(), options.sessionFile),
                session: session.value,
              }),
            },
          );

          return result.outcome === 'rejected'
            ? result
            : requestLocalService(state.stateDirectory, {
                ...result.value,
                operation: 'run_report',
              });
        });
      },
    );
  run
    .command('reconcile-queue <job-id>')
    .description('Recover a stopped preparation before worktree intent was saved')
    .requiredOption(
      '--writers-stopped',
      'Attest the original preparation writer and its children stopped',
    )
    .option('--json')
    .action(async (jobId: string, options: { writersStopped: boolean; json?: boolean }) => {
      const host = program.opts<{ stateDirectory?: string }>();
      const directory =
        host.stateDirectory === undefined
          ? join(homedir(), '.astack')
          : resolve(process.cwd(), host.stateDirectory);

      render(
        await reconcileLocalQueuedWorker(jobId, options.writersStopped, directory),
        options.json,
      );
    });
  run
    .command('reconcile <job-id>')
    .description(
      'With the coordinator stopped, verify owned Herdr workspace absence and record host-confirmed shutdown; release only bound worker holds',
    )
    .requiredOption('--key <key>')
    .requiredOption('--attempt <id>')
    .requiredOption('--launch <id>')
    .requiredOption('--revision <number>', 'Exact saved run control revision', number)
    .requiredOption('--worker-stopped', 'Attest the worker and all descendants have stopped')
    .requiredOption(
      '--services-stopped',
      'Attest all services started by this attempt have stopped',
    )
    .requiredOption('--writers-stopped', 'Attest all original effect writers have stopped')
    .option('--herdr-executable <path>')
    .option('--json')
    .action(
      async (
        jobId: string,
        options: {
          key: string;
          attempt: string;
          launch: string;
          revision: number;
          workerStopped: boolean;
          servicesStopped: boolean;
          writersStopped: boolean;
          herdrExecutable?: string;
          json?: boolean;
        },
      ) => {
        const host = program.opts<{ stateDirectory?: string }>();
        render(
          await reconcileLocalRun(
            {
              schemaVersion: 1,
              jobId,
              key: options.key,
              attemptId: options.attempt,
              launchId: options.launch,
              expectedRevision: options.revision,
              workerStopped: options.workerStopped,
              servicesStopped: options.servicesStopped,
              writersStopped: options.writersStopped,
            },
            {
              stateDirectory:
                host.stateDirectory === undefined
                  ? join(homedir(), '.astack')
                  : resolve(process.cwd(), host.stateDirectory),
              ...(options.herdrExecutable === undefined
                ? {}
                : { herdrExecutable: options.herdrExecutable }),
            },
          ),
          options.json,
        );
      },
    );
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
