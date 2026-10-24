import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { requestLocalService } from '../adapters/local/service-client.js';
import {
  inspectReviewAutomation,
  inspectFollowUpReview,
  listFollowUpReviews,
} from '../application/automatic-review.js';
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
    (result.value && 'followUpId' in result.value && result.value.phase === 'blocked')
  ) {
    process.exitCode = 1;
  }
}

export function wireAutomaticReviewCommands(program: Command, review: Command) {
  async function execute(
    json: boolean | undefined,
    action: (
      state: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>,
    ) => Promise<ServiceRpcResponse> | ServiceRpcResponse,
  ) {
    const selected = program.opts<{ stateDirectory?: string }>().stateDirectory;
    const state = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      ...(selected === undefined ? {} : { stateDirectory: resolve(process.cwd(), selected) }),
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

  const automation = review
    .command('automation')
    .description('Inspect or explicitly enable/disable project follow-up automation');
  automation
    .command('inspect')
    .requiredOption('--project <id>')
    .option('--json')
    .action(async (options: { project: string; json?: boolean }) => {
      await execute(options.json, (state) =>
        inspectReviewAutomation(
          { schemaVersion: 1, projectId: options.project },
          { store: state.automaticReviews },
        ),
      );
    });

  for (const enabled of [true, false]) {
    automation
      .command(enabled ? 'enable' : 'disable')
      .requiredOption('--project <id>')
      .requiredOption('--revision <number>', 'Exact settings revision', number)
      .option('--json')
      .action(async (options: { project: string; revision: number; json?: boolean }) => {
        await execute(options.json, (state) =>
          requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'review_automation_configure',
            projectId: options.project,
            expectedRevision: options.revision,
            enabled,
          }),
        );
      });
  }

  const followUp = review
    .command('follow-up')
    .description('Attach a dedicated owned checkout to one accepted handoff review request');
  followUp
    .command('enqueue')
    .requiredOption('--handoff <job-id>')
    .option('--handoff-key <key>')
    .requiredOption('--checkout <id>')
    .requiredOption('--branch <branch>')
    .requiredOption('--commit <sha>')
    .option('--timeout-ms <ms>', 'CI deadline duration, 1 second–7 days', number, 3600000)
    .option('--json')
    .action(
      async (options: {
        handoff: string;
        handoffKey?: string;
        checkout: string;
        branch: string;
        commit: string;
        timeoutMs: number;
        json?: boolean;
      }) => {
        await execute(options.json, (state) =>
          requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'follow_up_enqueue',
            jobId: options.handoff,
            ...(options.handoffKey === undefined ? {} : { handoffKey: options.handoffKey }),
            checkoutId: options.checkout,
            branch: options.branch.startsWith('refs/')
              ? options.branch
              : `refs/heads/${options.branch}`,
            commit: options.commit,
            timeoutMs: options.timeoutMs,
          }),
        );
      },
    );
  followUp
    .command('inspect <id>')
    .option('--json')
    .action(async (id: string, options: { json?: boolean }) => {
      await execute(options.json, (state) =>
        inspectFollowUpReview({ schemaVersion: 1, id }, { store: state.automaticReviews }),
      );
    });
  followUp
    .command('list')
    .requiredOption('--project <id>')
    .option('--after <id>')
    .option('--limit <number>', 'Page size, 1–100', number, 20)
    .option('--json')
    .action(async (options: { project: string; after?: string; limit: number; json?: boolean }) => {
      await execute(options.json, (state) =>
        listFollowUpReviews(
          {
            schemaVersion: 1,
            projectId: options.project,
            after: options.after ?? '',
            limit: options.limit,
          },
          { store: state.automaticReviews },
        ),
      );
    });

  for (const action of ['suspend', 'resume', 'cancel'] as const) {
    followUp
      .command(`${action} <id>`)
      .requiredOption('--revision <number>', 'Exact plan revision', number)
      .option('--json')
      .action(async (id: string, options: { revision: number; json?: boolean }) => {
        await execute(options.json, (state) =>
          requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'follow_up_control',
            id,
            expectedRevision: options.revision,
            action,
          }),
        );
      });
  }
}
