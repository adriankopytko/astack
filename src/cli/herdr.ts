import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  configureHerdrProject,
  ensureHerdrProject,
  inspectHerdrProject,
  prepareHerdrWorker,
  inspectHerdrWorker,
  bindHerdrAgent,
  reconcileHerdrSpace,
  type HerdrDependencies,
} from '../application/herdr.js';
import type { HerdrResult, HerdrSettings } from '../contracts/herdr.js';
import type { StateWriteResult } from '../contracts/state.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { createHerdrCliProvider } from '../adapters/herdr/cli-provider.js';
import { nodeHerdrEndpointReader } from '../adapters/filesystem/herdr-endpoint.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import {
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
} from '../adapters/filesystem/configuration.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { gitExecutable, hostExecutable } from '../core/host-git.js';
import { rejected } from '../contracts/operation-result.js';

function render(result: HerdrResult | StateWriteResult<HerdrSettings>, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else if (result.outcome === 'persisted') {
    process.stdout.write(
      `Project: ${result.value.projectId}\nHerdr session: ${result.value.target.session}\nConfiguration: ${result.disposition}\n`,
    );
  } else {
    process.stdout.write(
      `Outcome: ${result.outcome}\nProject: ${result.record?.projectId ?? 'unbound'}\nSpace: ${result.record?.id ?? 'none'}\nWorkspace: ${result.record?.handle?.workspaceId ?? 'none'}\nOperation: ${result.record?.operationId ?? 'none'}\nReason: ${result.reason ?? 'none'}\n`,
    );
  }

  if (
    ['blocked', 'pending', 'rejected', 'uncertain'].includes(result.outcome) ||
    ('reason' in result && result.reason !== null)
  ) {
    process.exitCode = 1;
  }
}

export function wireHerdrCommands(program: Command): void {
  program.option('--herdr-executable <absolute-path>', 'Select a trusted Herdr CLI executable');
  const herdr = program
    .command('herdr')
    .description('Reconcile explicit project spaces and owned worker layouts; never launch agents');

  async function execute(
    writable: boolean,
    json: boolean | undefined,
    action: (deps: HerdrDependencies) => Promise<HerdrResult | StateWriteResult<HerdrSettings>>,
  ) {
    const host = program.opts<{
      stateDirectory?: string;
      gitExecutable?: string;
      herdrExecutable?: string;
    }>();
    const opened = await openSqliteState({
      schemaVersion: 1,
      mode: writable ? 'read-write' : 'read-only',
      ...(host.stateDirectory === undefined
        ? {}
        : { stateDirectory: resolve(process.cwd(), host.stateDirectory) }),
    });

    if (opened.outcome !== 'opened') {
      render(opened, json);

      return;
    }

    try {
      const git = await gitExecutable(host.gitExecutable);

      if (!git) {
        render(
          rejected('git_unavailable', 'Select an absolute Git executable or add Git to host PATH.'),
          json,
        );

        return;
      }

      const executable = await hostExecutable('herdr', host.herdrExecutable);
      const deps: HerdrDependencies = {
        registry: opened.registry,
        state: opened.store,
        herdr: opened.herdr,
        git: createGitInspector({ executable: git, runner: nodeProcessRunner }),
        identity: nodeCheckoutIdentityReader,
        provider: createHerdrCliProvider({
          executable: executable ?? '',
          runner: nodeProcessRunner,
          endpoint: nodeHerdrEndpointReader,
        }),
        files: createNodeWorktreeFiles(join(opened.stateDirectory, 'worktrees')),
        configuration: createNodeConfigurationReader(opened.stateDirectory),
        prerequisites: createNodeConfigurationProbe(
          (name) => Object.hasOwn(process.env, name) && Boolean(process.env[name]),
        ),
        newId: () => randomUUID(),
      };
      render(await action(deps), json);
    } finally {
      if (opened.store.close().outcome === 'rejected') {
        process.stderr.write('State cleanup failed; inspect saved intent before retrying.\n');
        process.exitCode = 1;
      }
    }
  }

  herdr
    .command('configure')
    .description('Save project-local Herdr target; does not start or contact a server')
    .requiredOption('--project <id>', 'Registered project ID')
    .option('--session <name>', 'Explicit named session; default: shared default', 'default')
    .option(
      '--socket <path>',
      'Explicit socket path; default: standard path for the selected session',
    )
    .option('--label <text>', 'Human project label; never an identity selector')
    .option('--json', 'Print saved target evidence')
    .action(
      async (options: {
        project: string;
        session: string;
        socket?: string;
        label?: string;
        json?: boolean;
      }) => {
        const socketPath =
          options.socket === undefined
            ? options.session === 'default'
              ? join(homedir(), '.config', 'herdr', 'herdr.sock')
              : join(homedir(), '.config', 'herdr', 'sessions', options.session, 'herdr.sock')
            : resolve(process.cwd(), options.socket);
        await execute(true, options.json, (deps) =>
          configureHerdrProject(
            {
              schemaVersion: 1,
              projectId: options.project,
              target: { session: options.session, socketPath },
              ...(options.label === undefined ? {} : { label: options.label }),
            },
            deps,
          ),
        );
      },
    );

  for (const operation of ['ensure', 'inspect'] as const) {
    herdr
      .command(operation)
      .description(
        operation === 'ensure'
          ? 'Ensure one persistent primary project space without focus changes'
          : 'Inspect saved primary space and current layout',
      )
      .requiredOption('--project <id>', 'Explicit registered project ID')
      .option('--json', 'Print structured space evidence')
      .action(async (options: { project: string; json?: boolean }) => {
        await execute(operation === 'ensure', options.json, (deps) =>
          (operation === 'ensure' ? ensureHerdrProject : inspectHerdrProject)(
            { schemaVersion: 1, projectId: options.project },
            deps,
          ),
        );
      });
  }

  const worker = herdr
    .command('worker')
    .description('Open or inspect the grouped layout of an accepted attempt');

  for (const operation of ['prepare', 'inspect'] as const) {
    worker
      .command(operation)
      .description(
        operation === 'prepare'
          ? 'Open an owned existing worktree in the project group; no agent launch'
          : 'Verify worker layout and recorded attribution',
      )
      .requiredOption('--attempt <id>', 'Saved attempt ID')
      .option('--json', 'Print structured layout evidence')
      .action(async (options: { attempt: string; json?: boolean }) => {
        await execute(operation === 'prepare', options.json, (deps) =>
          (operation === 'prepare' ? prepareHerdrWorker : inspectHerdrWorker)(
            { schemaVersion: 1, attemptId: options.attempt },
            deps,
          ),
        );
      });
  }

  worker
    .command('bind-agent')
    .description('Record only an already detected agent with verified assignment; never start it')
    .requiredOption('--attempt <id>', 'Saved attempt ID')
    .requiredOption('--kind <kind>', 'Expected detected agent kind')
    .option('--json', 'Print verified attribution')
    .action(async (options: { attempt: string; kind: string; json?: boolean }) => {
      await execute(true, options.json, (deps) =>
        bindHerdrAgent({ schemaVersion: 1, attemptId: options.attempt, kind: options.kind }, deps),
      );
    });
  herdr
    .command('reconcile <id>')
    .description('Settle a pending layout using fresh evidence after trusted writer quiescence')
    .requiredOption('--operation <id>', 'Exact saved operation ID')
    .requiredOption(
      '--writer-stopped',
      'Host attestation that the previous layout writer and children stopped',
    )
    .option('--json', 'Print reconciliation evidence')
    .action(
      async (
        id: string,
        options: { operation: string; writerStopped: boolean; json?: boolean },
      ) => {
        await execute(true, options.json, (deps) =>
          reconcileHerdrSpace(
            {
              schemaVersion: 1,
              id,
              operationId: options.operation,
              writerStopped: options.writerStopped,
            },
            deps,
          ),
        );
      },
    );
}
