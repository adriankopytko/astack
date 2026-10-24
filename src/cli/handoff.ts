import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { Command, InvalidArgumentError } from 'commander';
import { z } from 'zod';
import { canonicalFileRoot, readRegularFile } from '../core/file-paths.js';
import { executeLocalHandoff } from '../host/handoff.js';
import { inspectImplementationHandoff } from '../application/handoff.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { rejected } from '../contracts/operation-result.js';
import { stateIdSchema } from '../contracts/state.js';
import type { HandoffView } from '../contracts/handoff.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { HandoffStore } from '../ports/handoff.js';

type Result =
  | OperationResult<HandoffView | null>
  | StateWriteResult<HandoffView>
  | ReturnType<HandoffStore['followUps']>;
function render(result: Result, json?: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else if (result.value === null) {
    process.stdout.write('Handoff not found.\n');
  } else if ('record' in result.value) {
    const value = result.value;
    process.stdout.write(
      `Handoff: ${value.record.id}\nState: ${value.record.phase}\nPush: ${value.push.state}\nPR: ${value.publication.state}\nReview request: ${value.record.followUpReview?.id ?? 'none'}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(result.value)}\n`);
  }

  if (
    'error' in result ||
    (result.value !== null && 'record' in result.value && result.value.record.phase !== 'accepted')
  ) {
    process.exitCode = 1;
  }
}

export function wireHandoffCommands(program: Command) {
  const command = program
    .command('handoff')
    .description('Explicitly validate and publish completed implementation results');
  const stateDirectory = () => {
    const selected = program.opts<{ stateDirectory?: string }>().stateDirectory;

    return selected === undefined
      ? join(homedir(), '.local', 'state', 'astack')
      : resolve(process.cwd(), selected);
  };

  const withState = async (json: boolean | undefined, action: (store: HandoffStore) => Result) => {
    const state = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      stateDirectory: stateDirectory(),
    });

    if (state.outcome !== 'opened') {
      render(state, json);

      return;
    }

    try {
      render(action(state.handoffs), json);
    } finally {
      state.store.close();
    }
  };

  type HostOptions = {
    writersStopped: boolean;
    gitExecutable?: string;
    githubExecutable?: string;
    json?: boolean;
  };
  const host = (options: HostOptions, mode: 'finish' | 'reconcile') => ({
    mode,
    stateDirectory: stateDirectory(),
    ...(options.gitExecutable === undefined ? {} : { gitExecutable: options.gitExecutable }),
    ...(options.githubExecutable === undefined
      ? {}
      : { githubExecutable: options.githubExecutable }),
  });

  command
    .command('finish')
    .description(
      'With the service stopped, publish an exact completed commit and save an optional authorized review request',
    )
    .requiredOption('--file <path>', 'Trusted handoff request JSON, at most 16000 bytes')
    .requiredOption(
      '--writers-stopped',
      'Attest all original writers and descendants are stopped and remain excluded',
    )
    .option('--git-executable <path>')
    .option('--github-executable <path>')
    .option('--json')
    .action(async (options: HostOptions & { file: string }) => {
      let request: unknown;

      try {
        const path = resolve(process.cwd(), options.file);
        const root = await canonicalFileRoot(dirname(path));
        const file = await readRegularFile(root, basename(path), 16000);

        if (!file) {
          throw new Error('Missing request');
        }

        request = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(file.bytes));
      } catch {
        render(
          rejected('invalid_request', 'Select a stable regular bounded UTF-8 JSON request file.'),
          options.json,
        );

        return;
      }

      render(
        await executeLocalHandoff(
          { schemaVersion: 1, request, writersStopped: options.writersStopped },
          host(options, 'finish'),
        ),
        options.json,
      );
    });
  command
    .command('reconcile <job-id>')
    .description(
      'Observe saved publication effects and accept positive evidence; never send remote writes',
    )
    .option('--key <key>')
    .requiredOption(
      '--writers-stopped',
      'Attest all original writers and descendants are stopped and remain excluded',
    )
    .option('--git-executable <path>')
    .option('--github-executable <path>')
    .option('--json')
    .action(async (jobId: string, options: HostOptions & { key?: string }) => {
      render(
        await executeLocalHandoff(
          {
            schemaVersion: 1,
            jobId,
            ...(options.key === undefined ? {} : { key: options.key }),
            writersStopped: options.writersStopped,
          },
          host(options, 'reconcile'),
        ),
        options.json,
      );
    });
  command
    .command('inspect <job-id>')
    .option('--key <key>')
    .option('--json')
    .action(async (jobId: string, options: { key?: string; json?: boolean }) => {
      await withState(options.json, (handoffs) =>
        inspectImplementationHandoff(
          { schemaVersion: 1, jobId, ...(options.key === undefined ? {} : { key: options.key }) },
          { handoffs },
        ),
      );
    });
  command
    .command('follow-ups')
    .requiredOption('--project <id>')
    .option('--after <id>')
    .option(
      '--limit <count>',
      'Page size, 1–100',
      (value: string) => {
        if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
          throw new InvalidArgumentError('Use a page size from 1 to 100.');
        }

        return Number(value);
      },
      20,
    )
    .option('--json')
    .action(async (options: { project: string; after?: string; limit: number; json?: boolean }) => {
      await withState(options.json, (store) => {
        const input = z
          .strictObject({
            projectId: stateIdSchema,
            after: z.union([z.literal(''), stateIdSchema]),
            limit: z.number().int().min(1).max(100),
          })
          .safeParse({
            projectId: options.project,
            after: options.after ?? '',
            limit: options.limit,
          });

        return input.success
          ? store.followUps(input.data)
          : rejected('invalid_request', 'Select a valid project, cursor and page size.');
      });
    });
}
