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
} from '../application/herdr.js';
import type { HerdrResult, HerdrSettings } from '../contracts/herdr.js';
import { runtimeCapabilities } from '../contracts/runtime.js';
import type { RuntimeStatus } from '../contracts/runtime.js';
import type { OperationResult } from '../contracts/operation-result.js';
import {
  inspectRuntime,
  reconcileRuntime,
  inputRuntime,
  interruptRuntime,
  authorizeRuntimeInputRetry,
  type RuntimeDependencies,
} from '../application/runtime.js';
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
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { StateError } from '../adapters/state/errors.js';
import type { CoordinatorOwnership } from '../ports/service.js';

type CommandResult = HerdrResult | StateWriteResult<HerdrSettings> | OperationResult<RuntimeStatus>;

function render(result: CommandResult, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if ('error' in result) {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else if (result.outcome === 'completed') {
    const value = result.value;
    process.stdout.write(
      `Runtime: codex-herdr\nState: ${value.state}\nLaunch: ${value.session?.launchId ?? 'none'}\nReason: ${value.reason ?? 'none'}\n`,
    );
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
    ('reason' in result && result.reason !== null) ||
    (result.outcome === 'completed' && ['blocked', 'unknown'].includes(result.value.state))
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
    action: (deps: RuntimeDependencies) => Promise<CommandResult>,
    codexExecutable?: string,
    exclusive = false,
  ) {
    const host = program.opts<{
      stateDirectory?: string;
      gitExecutable?: string;
      herdrExecutable?: string;
    }>();
    let ownership: CoordinatorOwnership | undefined;

    if (exclusive) {
      try {
        ownership = await acquireCoordinatorOwnership(
          host.stateDirectory === undefined
            ? join(homedir(), '.local', 'state', 'astack')
            : resolve(process.cwd(), host.stateDirectory),
        );
      } catch (error) {
        render(
          rejected(
            error instanceof StateError ? error.code : 'state_unavailable',
            'Retry authorization needs safe private state and exclusive coordinator ownership; stop all original input writers first.',
          ),
          json,
        );

        return;
      }
    }

    const opened = await openSqliteState({
      schemaVersion: 1,
      mode: writable ? 'read-write' : 'read-only',
      ...(host.stateDirectory === undefined
        ? {}
        : { stateDirectory: resolve(process.cwd(), host.stateDirectory) }),
    });

    if (opened.outcome !== 'opened') {
      ownership?.release();
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
      const provider = createHerdrCliProvider({
        executable: executable ?? '',
        runner: nodeProcessRunner,
        endpoint: nodeHerdrEndpointReader,
      });
      const deps: RuntimeDependencies = {
        registry: opened.registry,
        state: opened.store,
        herdr: opened.herdr,
        git: createGitInspector({ executable: git, runner: nodeProcessRunner }),
        identity: nodeCheckoutIdentityReader,
        provider,
        worker: provider,
        queue: opened.service,
        runtime: opened.runtime,
        canonicalCodexExecutable: (await hostExecutable('codex', codexExecutable)) ?? '',
        files: createNodeWorktreeFiles(join(opened.stateDirectory, 'worktrees')),
        configuration: createNodeConfigurationReader(opened.stateDirectory),
        prerequisites: createNodeConfigurationProbe(
          (name) => Object.hasOwn(process.env, name) && Boolean(process.env[name]),
        ),
        newId: () => randomUUID(),
      };
      render(await action(deps), json);
    } finally {
      ownership?.release();

      if (opened.store.close().outcome === 'rejected') {
        process.stderr.write('State cleanup failed; inspect saved intent before retrying.\n');
        process.exitCode = 1;
      }
    }
  }

  const runtime = program
    .command('runtime')
    .description('Inspect and control saved Herdr-owned Codex workers');
  runtime
    .command('capabilities')
    .description('Print supported controls and provider limits')
    .action(() => {
      process.stdout.write(`${JSON.stringify(runtimeCapabilities)}\n`);
    });

  runtime
    .command('authorize-input-retry')
    .description(
      'Host attestation of proven non-delivery; archive exact pending input and authorize a future retry, without sending it',
    )
    .requiredOption('--attempt <id>', 'Saved attempt')
    .requiredOption('--key <key>', 'Exact pending input key')
    .requiredOption('--digest <sha256>', 'Exact pending input digest')
    .requiredOption('--generation <number>', 'Exact pending action generation')
    .requiredOption(
      '--not-submitted',
      'Attest independent proof that this input never reached its worker',
    )
    .requiredOption(
      '--writer-stopped',
      'Attest original callers and their descendants stopped with no late write possible',
    )
    .option('--codex-executable <absolute-path>', 'Approved canonical Codex executable')
    .option('--json', 'Print saved authorization evidence')
    .action(
      async (options: {
        attempt: string;
        key: string;
        digest: string;
        generation: string;
        notSubmitted: boolean;
        writerStopped: boolean;
        codexExecutable?: string;
        json?: boolean;
      }) => {
        await execute(
          true,
          options.json,
          (deps) =>
            authorizeRuntimeInputRetry(
              {
                schemaVersion: 1,
                attemptId: options.attempt,
                key: options.key,
                digest: options.digest,
                generation: /^\d+$/.test(options.generation) ? Number(options.generation) : -1,
                notSubmitted: options.notSubmitted,
                writerStopped: options.writerStopped,
              },
              deps,
            ),
          options.codexExecutable,
          true,
        );
      },
    );

  for (const operation of ['inspect', 'reconcile', 'input', 'interrupt'] as const) {
    const command = runtime
      .command(operation)
      .description(
        operation === 'input'
          ? 'Submit bounded text from stdin once per key; never answer approval dialogs'
          : operation === 'interrupt'
            ? 'Request Escape once per key; does not prove cancellation or shutdown'
            : operation === 'reconcile'
              ? 'Associate observed launch identity without repeating external effects'
              : 'Read fresh worker identity and liveness',
      )
      .requiredOption('--attempt <id>', 'Saved service attempt')
      .option('--json', 'Print structured evidence');

    if (operation === 'input' || operation === 'interrupt') {
      command
        .requiredOption('--key <key>', 'Stable idempotency key for this exact action')
        .option(
          '--codex-executable <absolute-path>',
          'Approved canonical Codex path resolved by this server',
        );
    }

    command.action(
      async (options: {
        attempt: string;
        key?: string;
        json?: boolean;
        codexExecutable?: string;
      }) => {
        let text = '';

        if (operation === 'input') {
          let size = 0;
          const chunks: Buffer[] = [];

          for await (const chunk of process.stdin) {
            const buffer = Buffer.from(chunk as Uint8Array);
            size += buffer.length;

            if (size > 16_384) {
              render(
                rejected('invalid_request', 'Runtime input must fit 16 KiB UTF-8.'),
                options.json,
              );
              process.stdin.destroy();

              return;
            }

            chunks.push(buffer);
          }

          text = Buffer.concat(chunks).toString('utf8');

          if (text.includes('\uFFFD')) {
            render(
              rejected('invalid_request', 'Runtime input must be lossless UTF-8.'),
              options.json,
            );

            return;
          }
        }

        await execute(
          operation !== 'inspect',
          options.json,
          (deps) => {
            const input = { schemaVersion: 1, attemptId: options.attempt };

            switch (operation) {
              case 'inspect':
                return inspectRuntime(input, deps);
              case 'reconcile':
                return reconcileRuntime(input, deps);
              case 'input':
                return inputRuntime({ ...input, key: options.key, text }, deps);
              case 'interrupt':
                return interruptRuntime({ ...input, key: options.key }, deps);
            }
          },
          options.codexExecutable,
        );
      },
    );
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
