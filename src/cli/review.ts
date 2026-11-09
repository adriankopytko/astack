import { wireReviewResultCommands } from './review-results.js';
import { wireAutomaticReviewCommands } from './automatic-review.js';
import { requestStartingService } from './ensure-service.js';
import { submissionProject } from './submit-project.js';
import { renderQueuedWorker } from './render-queued-worker.js';
import { openSubmissionState } from './submission-state.js';
import { Command } from 'commander';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { inspectReview } from '../application/review.js';
import { inspectQueuedWorker } from '../application/inspect-worker-queue.js';
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
  } else if ('request' in result.value && 'state' in result.value) {
    process.stdout.write(renderQueuedWorker(result.value));
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
      'request' in result.value &&
      'state' in result.value &&
      !!result.value.error) ||
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
    startService = false,
  ) {
    const options = program.opts<{
      stateDirectory?: string;
      gitExecutable?: string;
      herdrExecutable?: string;
    }>();
    const state = await openSubmissionState(options, startService);

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
    .option('--project <id>', 'Registered project; inferred from the current repository if omitted')
    .requiredOption('--key <key>', 'Stable request key')
    .requiredOption('--commit <sha>', 'Explicit full PR head SHA already present locally')
    .option('--base <sha>', 'Full comparison base SHA; defaults to the PR base')
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
        project?: string;
        key: string;
        commit: string;
        base?: string;
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
        await execute(
          options.json,
          async (state) => {
            const host = program.opts<{ gitExecutable?: string; herdrExecutable?: string }>();
            const project = await submissionProject(
              options.project,
              state.registry,
              host.gitExecutable,
            );

            if (project.outcome === 'rejected') {
              return project;
            }

            return requestStartingService(
              state.stateDirectory,
              {
                schemaVersion: 1,
                operation: 'review_worker_submit',
                projectId: project.value,
                key: options.key,
                ...(options.base === undefined ? {} : { comparisonBase: options.base }),
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
                ...(options.instruction === undefined
                  ? {}
                  : { instructionPaths: options.instruction }),
                request: {},
              },
              host,
            );
          },
          true,
        );
      },
    );
  review
    .command('inspect <job-id>')
    .description('Read saved review evidence without contacting GitHub or agents')
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

        return inspectReview(
          { schemaVersion: 1, jobId: queued.value?.jobId ?? jobId },
          { queue: state.service },
        );
      });
    });
}
