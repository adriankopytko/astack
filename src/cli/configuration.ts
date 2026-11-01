import { join, resolve } from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Command } from 'commander';
import { selectProjectContext } from '../application/select-project-context.js';
import { writeManagedFile } from '../application/managed-files.js';
import { nodeManagedFileStore } from '../core/node-managed-file-store.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { prepareStateDirectory } from '../adapters/state/state-directory.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { readProjectConfiguration } from '../adapters/filesystem/configuration.js';
import { resolveConfiguration } from '../application/configuration.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import {
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
} from '../adapters/filesystem/configuration.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { ConfigurationResolution } from '../contracts/configuration.js';
import { gitExecutable } from './projects.js';

function render(result: OperationResult<ConfigurationResolution>, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.outcome === 'rejected') {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else {
    process.stdout.write(
      `Configuration: ${result.value.status}\nProposal: ${result.value.proposal}\nPolicy revision: ${result.value.snapshot?.policyRevision ?? 'none'}\n`,
    );

    for (const diagnostic of result.value.diagnostics) {
      process.stdout.write(
        `${diagnostic.code}${diagnostic.subject ? ` (${diagnostic.subject})` : ''}: ${diagnostic.nextStep}\n`,
      );
    }
  }

  if (result.outcome === 'rejected' || result.value.status === 'blocked') {
    process.exitCode = 1;
  }
}

export function wireConfigurationCommands(program: Command): void {
  const config = program.command('config').description('Inspect and approve project configuration');

  config
    .command('inspect')
    .alias('check')
    .description(
      'Resolve host-approved configuration and report unmet prerequisites without executing commands',
    )
    .requiredOption('--project <id>', 'Explicit registered project ID')
    .option('--checkout <id>', 'Explicit registered checkout; default: project primary')
    .option('--role <name>', 'Role to inspect', 'implementer')
    .option('--json', 'Print configuration, provenance, pinned skills, and diagnostics')
    .action(
      async (options: { project: string; checkout?: string; role: string; json?: boolean }) => {
        const host = program.opts<{ stateDirectory?: string; gitExecutable?: string }>();
        const opened = await openSqliteState({
          schemaVersion: 1,
          mode: 'read-only',
          ...(host.stateDirectory === undefined
            ? {}
            : { stateDirectory: resolve(process.cwd(), host.stateDirectory) }),
        });

        if (opened.outcome !== 'opened') {
          render(opened, options.json);

          return;
        }

        try {
          const executable = await gitExecutable(host.gitExecutable);

          if (!executable) {
            render(
              rejected('git_unavailable', 'Select an absolute Git executable or add Git to PATH.'),
              options.json,
            );

            return;
          }

          render(
            await resolveConfiguration(
              {
                schemaVersion: 1,
                projectId: options.project,
                role: options.role,
                ...(options.checkout === undefined ? {} : { checkoutId: options.checkout }),
              },
              {
                registry: opened.registry,
                git: createGitInspector({ executable, runner: nodeProcessRunner }),
                identity: nodeCheckoutIdentityReader,
                configuration: createNodeConfigurationReader(
                  opened.stateDirectory,
                  opened.registry,
                ),
                prerequisites: createNodeConfigurationProbe(
                  (name) => Object.hasOwn(process.env, name) && Boolean(process.env[name]),
                ),
              },
            ),
            options.json,
          );
        } finally {
          if (opened.store.close().outcome === 'rejected') {
            process.stderr.write(
              'State connection cleanup failed; inspect state before retrying.\n',
            );
            process.exitCode = 1;
          }
        }
      },
    );

  config
    .command('approve')
    .description('Approve the current project configuration digest for this host')
    .requiredOption('--project <id>', 'Explicit registered project ID')
    .option('--json')
    .action(async (options: { project: string; json?: boolean }) => {
      const host = program.opts<{ stateDirectory?: string; gitExecutable?: string }>();
      const directory =
        host.stateDirectory === undefined
          ? join(homedir(), '.astack')
          : resolve(process.cwd(), host.stateDirectory);
      let ownership: Awaited<ReturnType<typeof acquireCoordinatorOwnership>> | null = null;
      let opened: Awaited<ReturnType<typeof openSqliteState>> | null = null;

      try {
        const state = await prepareStateDirectory(directory, false);
        ownership = await acquireCoordinatorOwnership(state.root.path);
        opened = await openSqliteState({ schemaVersion: 1, stateDirectory: state.root.path });

        if (opened.outcome !== 'opened') {
          process.stdout.write(`${JSON.stringify(opened)}\n`);
          process.exitCode = 1;

          return;
        }

        const executable = await gitExecutable(host.gitExecutable);

        if (!executable) {
          throw new Error('Git unavailable');
        }

        const selected = await selectProjectContext(
          { schemaVersion: 1, projectId: options.project },
          {
            registry: opened.registry,
            git: createGitInspector({ executable, runner: nodeProcessRunner }),
            identity: nodeCheckoutIdentityReader,
          },
        );

        if (
          selected.outcome !== 'completed' ||
          !selected.value.project ||
          !selected.value.checkout
        ) {
          throw new Error('Project unavailable');
        }

        const root = selected.value.checkout.checkout.rootPath;
        const document = await readProjectConfiguration(root);
        const parsed =
          document && typeof document.value === 'object' && !Array.isArray(document.value)
            ? hostConfigurationPolicySchema.safeParse({
                ...document.value,
                projectId: options.project,
                repositoryId: selected.value.project.repository.id,
              })
            : null;

        if (!document || !parsed?.success) {
          throw new Error('Project configuration invalid');
        }

        const approvalRoot = join(state.root.path, 'approvals');
        await mkdir(approvalRoot, { mode: 0o700, recursive: true });
        const approvalInfo = await lstat(approvalRoot);

        if (
          !approvalInfo.isDirectory() ||
          approvalInfo.isSymbolicLink() ||
          (approvalInfo.mode & 0o077) !== 0 ||
          (process.getuid && approvalInfo.uid !== process.getuid()) ||
          (await realpath(approvalRoot)) !== approvalRoot
        ) {
          throw new Error('Unsafe approvals directory');
        }

        const result = await writeManagedFile(
          {
            schemaVersion: 1,
            root: approvalRoot,
            path: `${options.project}.json`,
            owner: 'astack:config-approval',
            assetVersion: '1',
            mode: 0o600,
            content: JSON.stringify({ schemaVersion: 1, digest: document.digest }) + '\n',
          },
          nodeManagedFileStore,
        );
        const after = await readProjectConfiguration(root);

        if (
          !['written', 'unchanged'].includes(result.outcome) ||
          after?.digest !== document.digest
        ) {
          throw new Error('Approval could not be confirmed');
        }

        process.stdout.write(
          options.json
            ? `${JSON.stringify({ schemaVersion: 1, outcome: 'approved', projectId: options.project, digest: document.digest })}\n`
            : `Approved configuration for ${options.project}: ${document.digest}\n`,
        );
      } catch {
        process.stdout.write(
          `${JSON.stringify(rejected('configuration_unavailable', 'Could not approve the current project configuration; check the registered project, configuration and coordinator ownership.'))}\n`,
        );
        process.exitCode = 1;
      } finally {
        if (opened?.outcome === 'opened') {
          opened.store.close();
        }

        ownership?.release();
      }
    });
}
