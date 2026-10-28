import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  allocationRequestSchema,
  allocationSelectorSchema,
  allocationRevisionSchema,
  allocationStartSchema,
  allocationRunningSchema,
  allocationReleaseSchema,
  allocationListSchema,
} from '../contracts/resources.js';
import { rejected } from '../contracts/operation-result.js';
import {
  reserveAllocation,
  inspectAllocation,
  listAllocations,
  startAllocation,
  confirmAllocationRunning,
  retainAllocation,
  releaseAllocation,
} from '../application/resources.js';
import { nodePortProbe } from '../adapters/network/port-probe.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { prepareStateDirectory } from '../adapters/state/state-directory.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { readRequestFile } from './request-file.js';
import type { AllocationRecord } from '../contracts/resources.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
type Result =
  | OperationResult<
      AllocationRecord | null | { items: AllocationRecord[]; nextCursor: string | null }
    >
  | StateWriteResult<AllocationRecord>;
function render(result: Result, json?: boolean) {
  process.stdout.write(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);

  if (
    'error' in result ||
    ('value' in result &&
      result.value &&
      'phase' in result.value &&
      ['probing', 'blocked'].includes(result.value.phase))
  ) {
    process.exitCode = 1;
  }
}

export function wireResourceCommands(program: Command) {
  const command = program
    .command('resources')
    .description(
      'Inspect and explicitly manage shared host allocations; never start or stop services',
    );
  const operations = {
    reserve: { schema: allocationRequestSchema, run: reserveAllocation },
    start: { schema: allocationStartSchema, run: startAllocation },
    running: { schema: allocationRunningSchema, run: confirmAllocationRunning },
    retain: { schema: allocationRevisionSchema, run: retainAllocation },
    release: { schema: allocationReleaseSchema, run: releaseAllocation },
  };
  const directory = () => {
    const selected = program.opts<{ stateDirectory?: string }>().stateDirectory;

    return selected === undefined ? undefined : resolve(process.cwd(), selected);
  };

  for (const [name, operation] of Object.entries(operations)) {
    command
      .command(name)
      .description(`Offline ${name}; read a versioned JSON request; refuses an active coordinator`)
      .requiredOption('--file <path>', 'Bounded JSON request file; contains no credentials')
      .option('--json')
      .action(async (options: { file: string; json?: boolean }) => {
        let input: unknown;

        try {
          input = operation.schema.parse(await readRequestFile(options.file, 16384));
        } catch {
          render(
            rejected('invalid_request', 'Select a valid bounded resource request file.'),
            options.json,
          );

          return;
        }

        try {
          const prepared = await prepareStateDirectory(directory(), true);
          const ownership = await acquireCoordinatorOwnership(prepared.root.path);

          try {
            const opened = await openSqliteState({
              schemaVersion: 1,
              stateDirectory: prepared.root.path,
            });

            if (opened.outcome !== 'opened') {
              render(opened, options.json);

              return;
            }

            try {
              render(
                await operation.run(input, {
                  allocations: opened.allocations,
                  ports: nodePortProbe,
                }),
                options.json,
              );
            } finally {
              opened.store.close();
            }
          } finally {
            ownership.release();
          }
        } catch (error) {
          render(stateRejection(error), options.json);
        }
      });
  }

  command
    .command('inspect <id>')
    .option('--json')
    .action(async (id: string, options: { json?: boolean }) => {
      const request = allocationSelectorSchema.safeParse({ schemaVersion: 1, id });

      if (!request.success) {
        render(rejected('invalid_request', 'Select a saved allocation ID.'), options.json);

        return;
      }

      const opened = await openSqliteState({
        schemaVersion: 1,
        mode: 'read-only',
        ...(directory() ? { stateDirectory: directory() } : {}),
      });

      if (opened.outcome !== 'opened') {
        render(opened, options.json);

        return;
      }

      try {
        render(inspectAllocation(request.data, { allocations: opened.allocations }), options.json);
      } finally {
        opened.store.close();
      }
    });
  command
    .command('list')
    .option('--project <id>')
    .option('--after <id>')
    .option('--limit <number>', 'Page size 1–100', '50')
    .option('--json')
    .action(
      async (options: { project?: string; after?: string; limit: string; json?: boolean }) => {
        const request = allocationListSchema.safeParse({
          schemaVersion: 1,
          ...(options.project ? { projectId: options.project } : {}),
          ...(options.after ? { after: options.after } : {}),
          limit: Number(options.limit),
        });

        if (!request.success) {
          render(
            rejected(
              'invalid_request',
              'Select a project/cursor and a page size between 1 and 100.',
            ),
            options.json,
          );

          return;
        }

        const selected = directory();
        const opened = await openSqliteState({
          schemaVersion: 1,
          mode: 'read-only',
          ...(selected ? { stateDirectory: selected } : {}),
        });

        if (opened.outcome !== 'opened') {
          render(opened, options.json);

          return;
        }

        try {
          render(listAllocations(request.data, { allocations: opened.allocations }), options.json);
        } finally {
          opened.store.close();
        }
      },
    );
}
