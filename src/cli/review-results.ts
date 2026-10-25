import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { Command } from 'commander';
import { executeLocalReviewResult } from '../host/review-results.js';
import { inspectReviewResult, inspectReviewPublication } from '../application/review-results.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { rejected } from '../contracts/operation-result.js';
import { readRequestFile } from './request-file.js';
export function wireReviewResultCommands(program: Command, review: Command) {
  const command = review
    .command('result')
    .description('Inspect accepted findings and explicitly publish exact-commit review evidence');
  const directory = () => {
    const selected = program.opts<{ stateDirectory?: string }>().stateDirectory;

    return selected === undefined
      ? join(homedir(), '.local', 'state', 'astack')
      : resolve(process.cwd(), selected);
  };

  function render(
    result:
      | Awaited<ReturnType<typeof executeLocalReviewResult>>
      | ReturnType<typeof inspectReviewResult>
      | ReturnType<typeof inspectReviewPublication>,
    json?: boolean,
  ) {
    if (json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if ('error' in result) {
      process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
    }

    if (
      'error' in result ||
      ('value' in result &&
        result.value &&
        'effect' in result.value &&
        result.value.effect.state !== 'confirmed')
    ) {
      process.exitCode = 1;
    }
  }

  for (const operation of ['inspect', 'publication'] as const) {
    const cmd = command
      .command(`${operation} <job-id>`)
      .requiredOption('--report-key <key>')
      .option('--json');

    if (operation === 'publication') {
      cmd.requiredOption('--key <key>');
    }

    cmd.action(
      async (jobId: string, options: { reportKey: string; key?: string; json?: boolean }) => {
        const state = await openSqliteState({
          schemaVersion: 1,
          mode: 'read-only',
          stateDirectory: directory(),
        });

        if (state.outcome !== 'opened') {
          render(state, options.json);

          return;
        }

        try {
          const input = { schemaVersion: 1, jobId, reportKey: options.reportKey };
          render(
            operation === 'inspect'
              ? inspectReviewResult(input, { runs: state.runs, results: state.reviewResults })
              : inspectReviewPublication(
                  { ...input, key: options.key },
                  { results: state.reviewResults },
                ),
            options.json,
          );
        } finally {
          state.store.close();
        }
      },
    );
  }

  for (const mode of ['observe', 'publish', 'reconcile'] as const) {
    const cmd = command
      .command(mode)
      .description('With the coordinator stopped, perform this explicitly requested host operation')
      .option('--git-executable <path>')
      .option('--github-executable <path>')
      .option('--json');

    if (mode === 'publish') {
      cmd.requiredOption(
        '--file <path>',
        'Trusted publication request JSON; no implicit approval or automatic fix loop',
      );
    } else {
      cmd.requiredOption('--job <id>').requiredOption('--report-key <key>');
    }

    if (mode === 'reconcile') {
      cmd.requiredOption('--key <key>');
    }

    if (mode !== 'observe') {
      cmd.requiredOption(
        '--writers-stopped',
        'Attest original writers and descendants stopped and remain excluded',
      );
    }

    cmd.action(
      async (options: {
        file?: string;
        job?: string;
        reportKey?: string;
        key?: string;
        writersStopped?: boolean;
        gitExecutable?: string;
        githubExecutable?: string;
        json?: boolean;
      }) => {
        let request: unknown;

        try {
          request =
            mode === 'publish'
              ? {
                  schemaVersion: 1,
                  request: await readRequestFile(options.file!, 8000),
                  writersStopped: options.writersStopped,
                }
              : {
                  schemaVersion: 1,
                  jobId: options.job,
                  reportKey: options.reportKey,
                  ...(mode === 'reconcile'
                    ? { key: options.key, writersStopped: options.writersStopped }
                    : {}),
                };
        } catch {
          render(
            rejected('invalid_request', 'Select a stable bounded UTF-8 JSON request file.'),
            options.json,
          );

          return;
        }

        render(
          await executeLocalReviewResult(request, {
            stateDirectory: directory(),
            mode,
            ...(options.gitExecutable ? { gitExecutable: options.gitExecutable } : {}),
            ...(options.githubExecutable ? { githubExecutable: options.githubExecutable } : {}),
          }),
          options.json,
        );
      },
    );
  }
}
