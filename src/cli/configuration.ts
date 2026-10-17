import { resolve } from 'node:path';
import { Command } from 'commander';
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
  program
    .command('config')
    .description('Inspect approved project and role configuration')
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
                configuration: createNodeConfigurationReader(opened.stateDirectory),
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
}
