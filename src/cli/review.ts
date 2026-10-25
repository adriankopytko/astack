import { wireReviewResultCommands } from './review-results.js';
import { wireAutomaticReviewCommands } from './automatic-review.js';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { requestLocalService } from '../adapters/local/service-client.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { inspectReview } from '../application/review.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';
function append(value: string, values: string[] = []): string[] {
  return [...values, value];
}

function render(result: ServiceRpcResponse, json?: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else if (result.value === null) {
    process.stdout.write('Review job not found.\n');
  } else if ('review' in result.value) {
    const { job, review, assignment } = result.value;
    const target = assignment.submission.target;
    process.stdout.write(
      `Job: ${job.job.id}\nAttempt: ${job.attempt.id}\nTarget: ${target.host}/${target.repository}#${target.number} @ ${target.sha}\nCheckout: ${job.job.checkoutId}\nState: ${review.state}\nDelivery: ${review.delivery}\nReason: ${review.reason ?? 'none'}\nAccepted result: ${review.acceptedOutcome ?? 'none'}\n`,
    );
  }

  if (
    'error' in result ||
    (result.value &&
      'review' in result.value &&
      ['blocked', 'failed', 'unknown', 'needs_decision'].includes(result.value.review.state))
  ) {
    process.exitCode = 1;
  }
}

export function wireReviewCommands(program: Command) {
  const review = program
    .command('review')
    .description('Delegate explicit review work with separately controlled follow-up automation');
  wireAutomaticReviewCommands(program, review);
  wireReviewResultCommands(program, review);
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

  review
    .command('submit')
    .requiredOption('--project <id>', 'Registered project')
    .requiredOption('--checkout <id>', 'Dedicated clean, ready Astack-owned reviewer checkout')
    .requiredOption('--key <key>', 'Stable request key')
    .requiredOption('--branch <branch>', 'Expected local reviewer branch')
    .requiredOption('--commit <sha>', 'Explicit full PR head SHA already present locally')
    .requiredOption('--repo <owner/repo>', 'Explicit base repository; normalized to lowercase')
    .requiredOption('--pr <number>', 'Explicit PR number')
    .option('--host <host>', 'Explicit GitHub hostname', 'github.com')
    .option(
      '--check <name>',
      'Required check name; repeat, otherwise all observed checks must pass',
      append,
      [],
    )
    .option(
      '--override-gate <reason>',
      'Explicit CI override reason; requires trusted host permission',
    )
    .option(
      '--allow-no-checks',
      'Allow an empty check set only with explicit trusted no-CI permission',
    )
    .option('--repeat', 'Create a new review attempt in a fresh dedicated checkout')
    .option(
      '--resource <name>',
      'Request isolated integration resource; blocks until provisioning exists',
      append,
      [],
    )
    .option(
      '--instruction <relative-path>',
      'Scoped Markdown instructions, replaces default AGENTS paths',
      append,
    )
    .option('--json', 'Print durable review identity, policy and saved evidence')
    .action(
      async (options: {
        project: string;
        checkout: string;
        key: string;
        branch: string;
        commit: string;
        repo: string;
        pr: string;
        host: string;
        check: string[];
        overrideGate?: string;
        repeat?: boolean;
        allowNoChecks?: boolean;
        resource: string[];
        instruction?: string[];
        json?: boolean;
      }) => {
        await execute(options.json, (state) =>
          requestLocalService(state.stateDirectory, {
            schemaVersion: 1,
            operation: 'review_submit',
            projectId: options.project,
            checkoutId: options.checkout,
            key: options.key,
            branch: options.branch.startsWith('refs/')
              ? options.branch
              : `refs/heads/${options.branch}`,
            commit: options.commit,
            target: {
              host: options.host.toLowerCase(),
              repository: options.repo.toLowerCase(),
              number: Number(options.pr),
              sha: options.commit,
            },
            gate: {
              requiredChecks: options.check,
              overrideReason: options.overrideGate ?? null,
              ...(options.allowNoChecks ? { allowNoChecks: true } : {}),
            },
            repeat: options.repeat ?? false,
            resources: options.resource,
            ...(options.instruction === undefined ? {} : { instructionPaths: options.instruction }),
            request: {},
          }),
        );
      },
    );
  review
    .command('inspect <job-id>')
    .description('Read saved review evidence without contacting GitHub or agents')
    .option('--json')
    .action(async (jobId: string, options: { json?: boolean }) => {
      await execute(options.json, async (state) =>
        inspectReview({ schemaVersion: 1, jobId }, { queue: state.service }),
      );
    });
}
