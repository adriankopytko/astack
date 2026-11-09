import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import type { ServiceError } from '../contracts/errors.js';

export function wireErrorCommands(program: Command) {
  const errors = program
    .command('errors')
    .description('Inspect recorded service and worker errors');
  async function read(id: string | null, limit: number, json: boolean) {
    const host = program.opts<{ stateDirectory?: string }>();
    const state = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      ...(host.stateDirectory
        ? { stateDirectory: resolve(process.cwd(), host.stateDirectory) }
        : {}),
    });

    if (state.outcome !== 'opened') {
      process.stdout.write(
        json ? `${JSON.stringify(state)}\n` : `${state.error.code}: ${state.error.message}\n`,
      );
      process.exitCode = 1;

      return;
    }

    try {
      const result = id === null ? state.errors.list(limit) : state.errors.read(id);

      if (json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (result.outcome === 'rejected') {
        process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
      } else {
        const records: ServiceError[] = Array.isArray(result.value)
          ? result.value
          : result.value
            ? [result.value]
            : [];

        if (!records.length) {
          process.stdout.write(id === null ? 'No recorded errors.\n' : 'Error not found.\n');
        }

        for (const record of records) {
          process.stdout.write(
            `${record.id} ${new Date(record.createdAt).toISOString()} ${record.operation} ${record.code}\n${record.message}\nProject: ${record.projectId ?? 'none'}  Job: ${record.jobId ?? 'none'}\n`,
          );
        }
      }

      if (result.outcome === 'rejected' || (id !== null && result.value === null)) {
        process.exitCode = 1;
      }
    } finally {
      state.store.close();
    }
  }

  errors
    .command('list')
    .option(
      '--limit <count>',
      'Number of recent errors (1–100)',
      (value: string) => {
        const count = Number(value);

        if (!Number.isInteger(count) || count < 1 || count > 100) {
          throw new InvalidArgumentError('Use an integer from 1 to 100.');
        }

        return count;
      },
      20,
    )
    .option('--json')
    .action(async (options: { limit: number; json?: boolean }) =>
      read(null, options.limit, options.json ?? false),
    );
  errors
    .command('inspect <id>')
    .option('--json')
    .action(async (id: string, options: { json?: boolean }) => read(id, 1, options.json ?? false));
}
