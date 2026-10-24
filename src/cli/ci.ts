import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { requestLocalService } from '../adapters/local/service-client.js';
import { inspectCi, listCi } from '../application/ci.js';
import { rejected } from '../contracts/operation-result.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';
function integer(value: string) {
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
    process.stdout.write('CI request not found.\n');
  } else if ('observation' in result.value) {
    const { record, observation } = result.value;
    process.stdout.write(
      `CI request: ${record.id}\nRevision: ${record.revision}\nState: ${record.phase}\nReason: ${record.reason ?? 'none'}\nTarget: ${record.binding.target.host}/${record.binding.target.repository}#${record.binding.target.number} @ ${record.binding.target.sha}\nLast observation: ${observation.lastObservedAt ?? 'none'}\nNext refresh: ${observation.nextRefreshAt}\nDeadline: ${record.deadlineAt}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(result.value)}\n`);
  }

  if (
    'error' in result ||
    (result.value && 'observation' in result.value && result.value.record.phase === 'blocked')
  ) {
    process.exitCode = 1;
  }
}

export function wireCiCommands(program: Command) {
  const ci = program
    .command('ci')
    .description('Persist and observe exact review CI targets without starting an agent');
  async function execute(
    json: boolean | undefined,
    action: (
      state: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>,
    ) => Promise<ServiceRpcResponse> | ServiceRpcResponse,
  ) {
    const directory = program.opts<{ stateDirectory?: string }>().stateDirectory;
    const state = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      ...(directory === undefined ? {} : { stateDirectory: resolve(process.cwd(), directory) }),
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

  ci.command('watch')
    .description('Enroll an authorized persisted handoff follow-up or existing review job')
    .option('--handoff <job-id>')
    .option('--handoff-key <key>')
    .option('--review <job-id>')
    .requiredOption('--key <key>', 'Stable CI request key')
    .option('--timeout-ms <ms>', 'Deadline from enrollment, 1000–604800000 ms', integer, 3600000)
    .option('--json')
    .action(
      async (options: {
        handoff?: string;
        handoffKey?: string;
        review?: string;
        key: string;
        timeoutMs: number;
        json?: boolean;
      }) => {
        await execute(options.json, (state) => {
          if (
            Boolean(options.handoff) === Boolean(options.review) ||
            (options.handoffKey !== undefined && options.handoff === undefined)
          ) {
            return rejected(
              'invalid_request',
              'Select exactly one --handoff or --review source; --handoff-key applies only to handoffs.',
            );
          }

          return requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'ci_watch',
            source: options.handoff
              ? {
                  kind: 'handoff',
                  jobId: options.handoff,
                  ...(options.handoffKey === undefined ? {} : { key: options.handoffKey }),
                }
              : { kind: 'review', jobId: options.review },
            key: options.key,
            timeoutMs: options.timeoutMs,
          });
        });
      },
    );
  ci.command('inspect <id>')
    .option('--json')
    .action(async (id: string, options: { json?: boolean }) => {
      await execute(options.json, (state) => inspectCi({ schemaVersion: 1, id }, { ci: state.ci }));
    });
  ci.command('list')
    .requiredOption('--project <id>')
    .option('--after <id>')
    .option('--limit <count>', 'Page size, 1–100', integer, 20)
    .option('--json')
    .action(async (options: { project: string; after?: string; limit: number; json?: boolean }) => {
      await execute(options.json, (state) =>
        listCi(
          {
            schemaVersion: 1,
            projectId: options.project,
            after: options.after ?? '',
            limit: options.limit,
          },
          { ci: state.ci },
        ),
      );
    });

  for (const action of ['suspend', 'cancel', 'complete', 'resume'] as const) {
    ci.command(`${action} <id>`)
      .requiredOption('--revision <number>', 'Exact currently saved revision', integer)
      .option('--timeout-ms <ms>', 'New deadline duration for explicit resume', integer)
      .option('--json')
      .action(
        async (id: string, options: { revision: number; timeoutMs?: number; json?: boolean }) => {
          await execute(options.json, (state) => {
            if (options.timeoutMs !== undefined && action !== 'resume') {
              return rejected('invalid_request', 'Only resume accepts a new deadline duration.');
            }

            return requestLocalService(state.stateDirectory, {
              schemaVersion: 1,
              operation: 'ci_control',
              id,
              expectedRevision: options.revision,
              action,
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            });
          });
        },
      );
  }

  ci.command('wake')
    .description('Wake the enabled observer; persisted schedules and budgets remain in force')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      await execute(options.json, (state) =>
        requestLocalService(state.stateDirectory, { schemaVersion: 1, operation: 'ci_wake' }),
      );
    });
}
