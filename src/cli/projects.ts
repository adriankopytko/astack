import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { registerProject } from '../application/register-project.js';
import { selectProjectContext } from '../application/select-project-context.js';
import { listProjects } from '../application/list-projects.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { emptyProjectRegistry } from '../adapters/state/empty-project-registry.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { rejected } from '../contracts/operation-result.js';
import type { ProjectRegistry } from '../ports/project-registry.js';
import type {
  ProjectSelection,
  ProjectList,
  ProjectRegistrationResult,
} from '../contracts/projects.js';
import type { OperationResult } from '../contracts/operation-result.js';

interface HostOptions {
  stateDirectory?: string;
  gitExecutable?: string;
}
interface SelectionOptions {
  project?: string;
  checkout?: string;
  run?: string;
  path?: string;
  json?: boolean;
}

async function gitExecutable(explicit?: string): Promise<string | null> {
  if (explicit !== undefined) {
    return isAbsolute(explicit) ? explicit : null;
  }

  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    if (!isAbsolute(directory)) {
      continue;
    }

    const candidate = join(directory, 'git');

    try {
      await access(candidate, constants.X_OK);

      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function render(
  result: OperationResult<ProjectSelection | ProjectList> | ProjectRegistrationResult,
  json: boolean | undefined,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.outcome === 'rejected' || result.outcome === 'uncertain') {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else if (result.outcome === 'persisted') {
    process.stdout.write(
      `Project: ${result.value.project.id}\nCheckout: ${result.value.checkout.id}\nRoot: ${result.value.checkout.rootPath}\nRegistration: ${result.disposition}\n`,
    );
  } else if ('items' in result.value) {
    process.stdout.write(
      result.value.items.length === 0
        ? 'No registered projects.\n'
        : result.value.items
            .map((item) => `${item.project.project.id}\t${item.primaryCheckout.rootPath}`)
            .join('\n') + '\n',
    );

    if (result.value.nextCursor) {
      process.stdout.write(`Next cursor: ${result.value.nextCursor}\n`);
    }
  } else {
    const value = result.value;
    process.stdout.write(
      `Source: ${value.source}\nRegistration: ${value.registration}\nProject: ${value.project?.project.id ?? 'unregistered'}\nCheckout: ${value.checkout?.checkout.id ?? 'unregistered'}\nRoot: ${value.git.checkout.rootPath}\nBranch: ${value.git.checkout.head.branch ?? 'detached'}\nCommit: ${value.git.checkout.head.commit ?? 'unborn'}\nGit: ready\nCodex / Herdr / GitHub: not checked\nConfiguration: not implemented (source: none)\nDelegation: unavailable\n`,
    );
  }

  if (result.outcome === 'rejected' || result.outcome === 'uncertain') {
    process.exitCode = 1;
  }
}

async function withRegistry(
  program: Command,
  writable: boolean,
  json: boolean | undefined,
  action: (registry: ProjectRegistry, host: HostOptions) => Promise<void>,
): Promise<void> {
  const host = program.opts<HostOptions>();
  const opened = await openSqliteState({
    schemaVersion: 1,
    mode: writable ? 'read-write' : 'read-only',
    ...(host.stateDirectory === undefined
      ? {}
      : { stateDirectory: resolve(process.cwd(), host.stateDirectory) }),
  });

  if (opened.outcome === 'rejected') {
    if (!writable && opened.error.code === 'state_not_found') {
      await action(emptyProjectRegistry, host);

      return;
    }

    render(opened, json);

    return;
  }

  try {
    await action(opened.registry, host);
  } finally {
    const closed = opened.store.close();

    if (closed.outcome === 'rejected') {
      process.stderr.write('State connection cleanup failed; inspect state before retrying.\n');
      process.exitCode = 1;
    }
  }
}

export function wireProjectCommands(program: Command): void {
  program
    .option('--state-directory <path>', 'Use an isolated host state directory')
    .option('--git-executable <path>', 'Use an absolute trusted Git executable');
  const project = program
    .command('project')
    .description('Register checkouts and list project identities');
  project
    .command('register [path]')
    .description('Deliberately register a canonical checkout; default: caller directory')
    .option('--id <project-id>', 'Assign or assert a stable project ID')
    .option('--json', 'Print the versioned persistence result')
    .action(async (path: string | undefined, options: { id?: string; json?: boolean }) => {
      await withRegistry(program, true, options.json, async (registry, host) => {
        const executable = await gitExecutable(host.gitExecutable);

        if (executable === null) {
          render(
            rejected('git_unavailable', 'Select an absolute Git executable or add Git to PATH.'),
            options.json,
          );

          return;
        }

        const result = await registerProject(
          {
            schemaVersion: 1,
            path: resolve(process.cwd(), path ?? '.'),
            ...(options.id === undefined ? {} : { projectId: options.id }),
          },
          {
            registry,
            git: createGitInspector({ executable, runner: nodeProcessRunner }),
            identity: nodeCheckoutIdentityReader,
            now: Date.now,
            nextId: (kind) => `${kind}-${randomUUID()}`,
          },
        );
        render(result, options.json);
      });
    });
  project
    .command('list')
    .description('List recorded project identities without inspecting or adopting checkouts')
    .option('--after <project-id>', 'Continue after a saved page cursor')
    .option(
      '--limit <count>',
      'Page size, 1–100',
      (value: string) => {
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 100) {
          throw new InvalidArgumentError('Use an integer from 1 to 100.');
        }

        return Number(value);
      },
      50,
    )
    .option('--json', 'Print versioned project records')
    .action(async (options: { after?: string; limit: number; json?: boolean }) => {
      await withRegistry(program, false, options.json, async (registry) => {
        render(
          await listProjects(
            {
              schemaVersion: 1,
              limit: options.limit,
              ...(options.after === undefined ? {} : { after: options.after }),
            },
            registry,
          ),
          options.json,
        );
      });
    });
  program
    .command('context')
    .alias('doctor')
    .description('Inspect target identity, selection source, and orchestration readiness')
    .option('--project <project-id>', 'Select a registered project')
    .option('--checkout <checkout-id>', 'Select a registered checkout')
    .option('--run <attempt-id>', 'Bind to an existing saved attempt')
    .option('--path <path>', 'Inspect or assert an explicit checkout path')
    .option('--json', 'Print versioned context facts')
    .action(async (options: SelectionOptions) => {
      await withRegistry(program, false, options.json, async (registry, host) => {
        const executable = await gitExecutable(host.gitExecutable);

        if (executable === null) {
          render(
            rejected('git_unavailable', 'Select an absolute Git executable or add Git to PATH.'),
            options.json,
          );

          return;
        }

        render(
          await selectProjectContext(
            {
              schemaVersion: 1,
              callerDirectory: process.cwd(),
              ...(options.project === undefined ? {} : { projectId: options.project }),
              ...(options.checkout === undefined ? {} : { checkoutId: options.checkout }),
              ...(options.run === undefined ? {} : { runId: options.run }),
              ...(options.path === undefined ? {} : { path: resolve(process.cwd(), options.path) }),
            },
            {
              registry,
              git: createGitInspector({ executable, runner: nodeProcessRunner }),
              identity: nodeCheckoutIdentityReader,
            },
          ),
          options.json,
        );
      });
    });
}
