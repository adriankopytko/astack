import { Command } from 'commander';
import { rejected } from '../contracts/operation-result.js';
import { randomUUID } from 'node:crypto';
import { openSubmissionState } from './submission-state.js';
import { submissionProject } from './submit-project.js';
import { requestStartingService } from './ensure-service.js';
import { renderQueuedWorker } from './render-queued-worker.js';
import { readGithubOrigin } from '../adapters/git/github-origin.js';
import { gitExecutable } from '../core/host-git.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';

export function wireHandoffCommands(program: Command) {
  const command = program.command('handoff').description('Hand work to a configured agent');

  command
    .command('submit')
    .description('Queue a task for a project-defined agent')
    .option('--project <id>', 'Registered project; inferred from the current repository if omitted')
    .requiredOption('--agent <name>', 'Project-defined agent')
    .option('--task <text>', 'Task for the agent')
    .option('--issue <number>', 'Include the full GitHub issue')
    .option('--pr <number>', 'Include the full GitHub pull request')
    .option('--repo <owner/repo>', 'Override the GitHub repository inferred from origin')
    .option('--host <host>', 'Override the GitHub host')
    .option('--base <ref>', 'Full starting commit SHA or pr-head; defaults to newest origin/main')
    .option('--json')
    .action(
      async (options: {
        project?: string;
        agent: string;
        task?: string;
        issue?: string;
        pr?: string;
        repo?: string;
        host?: string;
        base?: string;
        json?: boolean;
      }) => {
        const fail = (error: ReturnType<typeof rejected>) => {
          process.stdout.write(`${options.json ? JSON.stringify(error) : error.error.message}\n`);
          process.exitCode = 1;
        };

        if (
          (!options.task && !options.issue && !options.pr) ||
          (options.issue && options.pr) ||
          ((options.repo || options.host) && !options.issue && !options.pr)
        ) {
          fail(
            rejected(
              'invalid_request',
              'Provide a task, an issue, or a PR; issue and PR are mutually exclusive.',
            ),
          );

          return;
        }

        const host = program.opts<{
          stateDirectory?: string;
          gitExecutable?: string;
          herdrExecutable?: string;
        }>();
        const state = await openSubmissionState(host, true);

        if (state.outcome !== 'opened') {
          process.stdout.write(`${options.json ? JSON.stringify(state) : state.error.message}\n`);
          process.exitCode = 1;

          return;
        }

        try {
          const project = await submissionProject(
            options.project,
            state.registry,
            host.gitExecutable,
          );

          if (project.outcome === 'rejected') {
            process.stdout.write(
              `${options.json ? JSON.stringify(project) : project.error.message}\n`,
            );
            process.exitCode = 1;

            return;
          }

          let context:
            | { kind: 'issue' | 'pr'; host: string; repository: string; number: number }
            | undefined;

          if (options.issue || options.pr) {
            let target = options.repo
              ? { host: options.host ?? 'github.com', repository: options.repo }
              : undefined;

            if (!target) {
              const saved = await state.registry.readProject(project.value);
              const checkout =
                saved.outcome === 'completed' && saved.value
                  ? await state.registry.readCheckout(saved.value.project.primaryCheckoutId)
                  : null;
              const git = await gitExecutable(host.gitExecutable);

              if (
                !checkout ||
                checkout.outcome !== 'completed' ||
                !checkout.value?.registered ||
                !git
              ) {
                fail(rejected('git_failed', 'Cannot identify the project origin; supply --repo.'));

                return;
              }

              const origin = await readGithubOrigin(
                checkout.value.checkout.rootPath,
                git,
                nodeProcessRunner,
              );

              if (origin.outcome === 'rejected') {
                fail(origin);

                return;
              }

              target = { ...origin.value, ...(options.host ? { host: options.host } : {}) };
            }

            context = {
              kind: options.issue ? 'issue' : 'pr',
              host: target.host.toLowerCase(),
              repository: target.repository.toLowerCase(),
              number: Number(options.issue ?? options.pr),
            };
          }

          const handoffId = `job-${randomUUID()}`;
          const result = await requestStartingService(
            state.stateDirectory,
            {
              schemaVersion: 1,
              operation: 'handoff_submit',
              projectId: project.value,
              agent: options.agent,
              key: handoffId,
              task:
                options.task ??
                'Work on the provided GitHub context according to your agent instructions.',
              ...(context ? { context } : {}),
              ...(options.base ? { baseCommit: options.base } : {}),
              request: {},
            },
            host,
          );

          if (options.json) {
            process.stdout.write(
              `${JSON.stringify(result.outcome === 'persisted' ? result : { ...result, handoffId })}\n`,
            );
          } else if ('error' in result) {
            process.stdout.write(
              `${result.error.code}: ${result.error.message}\nHandoff ID: ${handoffId}. Inspect this ID before retrying.\n`,
            );
          } else if (result.value && 'request' in result.value && 'state' in result.value) {
            process.stdout.write(renderQueuedWorker(result.value));
          }

          if (result.outcome === 'rejected' || result.outcome === 'uncertain') {
            process.exitCode = 1;
          }
        } finally {
          state.store.close();
        }
      },
    );
}
