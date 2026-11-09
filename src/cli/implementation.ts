import { readRequestFile } from './request-file.js';
import { requestStartingService } from './ensure-service.js';
import { submissionProject } from './submit-project.js';
import { rejected } from '../contracts/operation-result.js';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { inspectImplementation } from '../application/implementation.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';

function render(result: ServiceRpcResponse, json?: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else if (result.value === null) {
    process.stdout.write('Implementation job not found.\n');
  } else if ('implementation' in result.value) {
    const { job, implementation } = result.value;
    process.stdout.write(
      `Job: ${job.job.id}\nAttempt: ${job.attempt.id}\nProject: ${job.job.projectId}\nCheckout: ${job.job.checkoutId}\nState: ${implementation.state}\nDelivery: ${implementation.delivery}\nReason: ${implementation.reason ?? 'none'}\nAccepted result: ${implementation.acceptedOutcome ?? 'none'}\n`,
    );
  }

  if (
    'error' in result ||
    (result.value &&
      'implementation' in result.value &&
      ['blocked', 'failed', 'unknown', 'needs_decision'].includes(
        result.value.implementation.state,
      ))
  ) {
    process.exitCode = 1;
  }
}

function append(value: string, values: string[] = []): string[] {
  return [...values, value];
}

export function wireImplementationCommands(program: Command) {
  const implementation = program
    .command('implement')
    .description('Delegate an implementation task with an automatically prepared worker checkout');
  async function execute(
    json: boolean | undefined,
    action: (
      state: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>,
    ) => Promise<ServiceRpcResponse>,
  ) {
    const options = program.opts<{ stateDirectory?: string }>();
    const opened = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      ...(options.stateDirectory === undefined
        ? {}
        : { stateDirectory: resolve(process.cwd(), options.stateDirectory) }),
    });

    if (opened.outcome !== 'opened') {
      render(opened, json);

      return;
    }

    try {
      render(await action(opened), json);
    } finally {
      opened.store.close();
    }
  }

  implementation
    .command('submit')
    .description(
      'Persist task, instruction references, approved policy and attempt before dispatch',
    )
    .option('--project <id>', 'Registered project; inferred from the current repository if omitted')
    .requiredOption('--key <key>', 'Stable implementation submission key')
    .option(
      '--base <sha>',
      'Optional full base commit SHA; defaults to freshly fetched origin/main',
    )
    .requiredOption('--task <text>', 'Selected task without credentials')
    .option('--criterion <text>', 'Acceptance criterion; repeatable', append, [])
    .option(
      '--instruction <relative-path>',
      'Repository Markdown instructions; repeatable, replaces default AGENTS paths',
      append,
    )
    .option(
      '--fix-of <path>',
      'Bounded accepted review fix reference JSON; requires a fresh owned checkout',
    )
    .option('--json', 'Print durable identity and saved workflow state')
    .action(
      async (options: {
        project?: string;
        key: string;
        base?: string;
        task: string;
        fixOf?: string;
        criterion: string[];
        instruction?: string[];
        json?: boolean;
      }) => {
        let fixOf: unknown;

        try {
          fixOf =
            options.fixOf === undefined ? undefined : await readRequestFile(options.fixOf, 4000);
        } catch {
          render(
            rejected('invalid_request', 'Select a bounded stable JSON review fix reference.'),
            options.json,
          );

          return;
        }

        await execute(options.json, async (state) => {
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
              operation: 'implement_worker_submit',
              ...(fixOf === undefined ? {} : { fixOf }),
              projectId: project.value,
              key: options.key,
              ...(options.base === undefined ? {} : { baseCommit: options.base }),
              description: options.task,
              acceptanceCriteria: options.criterion,
              ...(options.instruction === undefined
                ? {}
                : { instructionPaths: options.instruction }),
              request: {},
            },
            host,
          );
        });
      },
    );
  implementation
    .command('inspect <job-id>')
    .description('Read saved implementation delivery/blocker evidence without contacting providers')
    .option('--json', 'Print saved workflow evidence; this does not accept worker results')
    .action(async (jobId: string, options: { json?: boolean }) => {
      await execute(options.json, async (state) =>
        inspectImplementation({ schemaVersion: 1, jobId }, { queue: state.service }),
      );
    });
}
