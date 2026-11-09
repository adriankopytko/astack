import { requestLocalService } from '../adapters/local/service-client.js';
import { initializationResultSchema } from '../contracts/initialization.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  initializeProject,
  type InitializationDependencies,
} from '../application/initialization.js';
import type { InitializationResult } from '../contracts/initialization.js';
import { rejected } from '../contracts/operation-result.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { emptyProjectRegistry } from '../adapters/state/empty-project-registry.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { prepareStateDirectory } from '../adapters/state/state-directory.js';
import { stateRejection } from '../adapters/state/errors.js';
import { nodeInitializationFiles } from '../adapters/filesystem/initialization.js';
import { nodeManagedFileStore } from '../core/node-managed-file-store.js';
import { createBundledSkillReader } from '../adapters/filesystem/skill-bundle.js';
import { nodeSkillDirectories } from '../adapters/filesystem/skill-directories.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import {
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
} from '../adapters/filesystem/configuration.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { createHerdrCliProvider } from '../adapters/herdr/cli-provider.js';
import { nodeHerdrEndpointReader } from '../adapters/filesystem/herdr-endpoint.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { gitExecutable, hostExecutable } from '../core/host-git.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { userSkillsRoot } from './skills.js';
type State = Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>;
interface Options {
  project?: string;
  checkout?: string;
  id?: string;
  dryRun?: boolean;
  nonInteractive?: boolean;
  withSkills?: boolean;
  userSkillsRoot?: string;
  herdrSession?: string;
  herdrSocket?: string;
  herdrLabel?: string;
  json?: boolean;
}
function render(result: InitializationResult, json?: boolean) {
  if (result.outcome !== 'rejected') {
    const view = result.view;
    const steps: string[] = [];

    if (result.outcome === 'previewed') {
      steps.push('Run astack init without --dry-run to apply this plan.');
    } else {
      const unconfigured = view.configuration.filter(
        (item) => item.result.outcome !== 'completed' || item.result.value.status !== 'ready',
      );

      if (unconfigured.length || view.configuration.length === 0) {
        steps.push(
          `Review project instructions and configure ${unconfigured.map((item) => item.role).join(', ') || 'the agents'} in ${join(view.target.root, '.astack', 'config.json')}; use astack config-schema for valid fields.`,
        );
      }

      if (
        view.projectSkills?.outcome === 'installed' ||
        view.projectSkills?.outcome === 'unchanged'
      ) {
        steps.push(
          'Commit and push the project setup, skills and instructions before delegation so they are present in the commit used for worker worktrees.',
        );
      }

      if (view.provider.status === 'blocked' || view.provider.status === 'pending') {
        steps.push(
          'Resolve the Herdr workspace error before delegating; inspect any pending operation before retrying.',
        );
      }

      if (view.target.projectId && unconfigured.length) {
        steps.push(
          `Run astack doctor --project ${view.target.projectId} --role <agent> to check the configuration.`,
        );
      }

      if (result.outcome === 'initialized' && view.provider.status === 'ready') {
        steps.push(
          'Ensure the Astack service is running with the Codex runtime enabled: astack service run --codex-herdr (if it is not already running).',
        );
      }

      if (result.outcome === 'initialized' && view.delegation === 'ready') {
        steps.push(
          'Submit an implementation or review task; Astack prepares the worker checkout and workspace.',
        );
      }
    }

    result = { ...result, view: { ...view, nextSteps: steps } };
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.outcome === 'rejected') {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else {
    const view = result.view;
    process.stdout.write(
      `Outcome: ${result.outcome}\nRoot: ${view.target.root}\nProject: ${view.target.projectId ?? 'registration required'}\nRegistration: ${view.registration}\nDelegation: ${view.delegation} (configuration and workspace only; service not checked)\nHerdr workspace: ${view.provider.status === 'planned' ? 'not checked' : view.provider.status}\n`,
    );

    for (const asset of view.assets) {
      process.stdout.write(
        `${asset.kind}: ${asset.state}${asset.reason ? ` (${asset.reason})` : ''}\n`,
      );
    }

    const projectSkills = view.projectSkills;

    if (projectSkills?.outcome === 'rejected') {
      process.stdout.write(
        `Project skills: ${projectSkills.error.code}: ${projectSkills.error.message}\n`,
      );
    } else if (projectSkills) {
      const skills =
        projectSkills.outcome === 'completed' ? projectSkills.value : projectSkills.view;
      process.stdout.write(`Project skills: ${projectSkills.outcome}\n`);

      for (const skill of skills.skills) {
        process.stdout.write(
          `  ${skill.asset.name}: ${skill.state}${skill.reason ? ` (${skill.reason})` : ''}\n`,
        );
      }
    }

    if (view.provider.result && 'record' in view.provider.result && view.provider.result.record) {
      const workspace = view.provider.result.record;
      const action =
        view.provider.result.outcome === 'prepared' ? 'created' : view.provider.result.outcome;
      process.stdout.write(
        `Herdr workspace: ${action} ${workspace.label} (${workspace.handle?.workspaceId ?? 'pending'})\n`,
      );
    }

    if (view.userSkills.outcome === 'completed') {
      process.stdout.write(
        `User orchestrator skill: ${view.userSkills.value.available ? 'available' : 'missing/outdated'}\n`,
      );
    }

    for (const item of view.diagnostics) {
      process.stdout.write(`${item.code}: ${item.message}\n`);
    }

    for (const item of view.configuration) {
      process.stdout.write(`${item.role} readiness: ${item.readiness}\n`);

      if (item.result.outcome === 'rejected') {
        process.stdout.write(`${item.role}: ${item.result.error.code}\n`);
      } else {
        for (const diagnostic of item.result.value.diagnostics) {
          process.stdout.write(`${item.role}: ${diagnostic.code} — ${diagnostic.nextStep}\n`);
        }
      }
    }

    if (view.nextSteps?.length) {
      process.stdout.write('Next steps:\n');

      for (const [index, step] of view.nextSteps.entries()) {
        process.stdout.write(`${index + 1}. ${step}\n`);
      }
    }
  }

  if (result.outcome === 'rejected' || result.outcome === 'partial') {
    process.exitCode = 1;
  }
}

function compose(
  state: State | null,
  root: string,
  executable: string,
  skillsRoot: string,
  herdr: string | null,
): InitializationDependencies {
  const registry = state?.registry ?? emptyProjectRegistry;
  const shared = {
    registry,
    git: createGitInspector({ executable, runner: nodeProcessRunner }),
    identity: nodeCheckoutIdentityReader,
    configuration: createNodeConfigurationReader(registry, state?.store),
    prerequisites: createNodeConfigurationProbe((name) => Boolean(process.env[name])),
  };

  return {
    ...shared,
    now: Date.now,
    nextId: (kind) => `${kind}-${randomUUID()}`,
    files: nodeManagedFileStore,
    layout: nodeInitializationFiles,
    skills: {
      bundle: createBundledSkillReader(),
      directories: nodeSkillDirectories,
      files: nodeManagedFileStore,
    },
    userSkillsRoot: skillsRoot,
    defaultHerdrTarget: {
      session: 'default',
      socketPath: join(homedir(), '.config', 'herdr', 'herdr.sock'),
    },
    ...(state
      ? {
          worktrees: state.worktrees,
          herdr: {
            ...shared,
            state: state.store,
            herdr: state.herdr,
            files: createNodeWorktreeFiles(join(root, 'worktrees')),
            newId: randomUUID,
            provider: herdr
              ? createHerdrCliProvider({
                  executable: herdr,
                  runner: nodeProcessRunner,
                  endpoint: nodeHerdrEndpointReader,
                })
              : {
                  snapshot: async () =>
                    rejected(
                      'herdr_unavailable',
                      'Select a trusted Herdr executable to prepare the project space.',
                    ),
                  createPrimary: async () => rejected('herdr_unavailable', 'Herdr is unavailable.'),
                },
          },
        }
      : {}),
  };
}

export function wireInitializationCommand(program: Command) {
  program
    .command('init [path]')
    .description(
      'Initialize one explicit repository conservatively; never launch workers or execute project scripts',
    )
    .option('--project <id>', 'Select an existing registered project from any caller directory')
    .option('--checkout <id>', 'Select an existing registered checkout; selectors must agree')
    .option('--id <id>', 'Assign a new project ID or assert the selected saved ID')
    .option('--dry-run', 'Read-only plan; no registration, files, state or provider setup')
    .option('--non-interactive', 'Report remaining decisions without prompts (also the default)')
    .option('--with-skills', 'Install all bundled project skills')
    .option(
      '--user-skills-root <directory>',
      'Inspect global orchestrator availability at this root; never install globally',
    )
    .option('--herdr-session <session>', 'Explicit project session; requires --herdr-socket')
    .option('--herdr-socket <path>', 'Explicit project socket; requires --herdr-session')
    .option('--herdr-label <label>', 'Label for new settings; existing settings are preserved')
    .option('--json')
    .action(async (path: string | undefined, options: Options) => {
      if ((options.herdrSession === undefined) !== (options.herdrSocket === undefined)) {
        program.error('Provide both --herdr-session and --herdr-socket.');
      }

      const host = program.opts<{
        stateDirectory?: string;
        gitExecutable?: string;
        herdrExecutable?: string;
      }>();
      const root =
        host.stateDirectory === undefined
          ? join(homedir(), '.astack')
          : resolve(process.cwd(), host.stateDirectory);
      const executable = await gitExecutable(host.gitExecutable);

      if (!executable) {
        render(rejected('git_unavailable', 'Select a trusted Git executable.'), options.json);

        return;
      }

      const bundle = options.withSkills ? await createBundledSkillReader().read() : null;

      if (bundle?.outcome === 'rejected') {
        render(bundle, options.json);

        return;
      }

      const request = {
        schemaVersion: 1,
        callerDirectory: process.cwd(),
        ...(path === undefined ? {} : { path: resolve(process.cwd(), path) }),
        ...(options.project === undefined ? {} : { projectId: options.project }),
        ...(options.checkout === undefined ? {} : { checkoutId: options.checkout }),
        ...(options.id === undefined ? {} : { assignProjectId: options.id }),
        skills: bundle?.value.catalog.skills.map((skill) => skill.id) ?? [],
        ...(options.herdrSession || options.herdrLabel
          ? {
              herdr: {
                ...(options.herdrSession && options.herdrSocket
                  ? {
                      target: {
                        session: options.herdrSession,
                        socketPath: resolve(process.cwd(), options.herdrSocket),
                      },
                    }
                  : {}),
                ...(options.herdrLabel === undefined ? {} : { label: options.herdrLabel }),
              },
            }
          : {}),
      };
      const opened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: root,
        mode: 'read-only',
      });

      if (opened.outcome !== 'opened' && opened.error.code !== 'state_not_found') {
        render(opened, options.json);

        return;
      }

      let preview: InitializationResult;

      try {
        preview = await initializeProject(
          { ...request, preview: true },
          compose(
            opened.outcome === 'opened' ? opened : null,
            opened.outcome === 'opened' ? opened.stateDirectory : root,
            executable,
            userSkillsRoot(options.userSkillsRoot),
            null,
          ),
        );
      } finally {
        if (opened.outcome === 'opened') {
          opened.store.close();
        }
      }

      if (options.dryRun || preview.outcome === 'rejected') {
        render(preview, options.json);

        return;
      }

      try {
        const selected = await prepareStateDirectory(root, false);
        const ownership = await acquireCoordinatorOwnership(selected.root.path);

        try {
          const state = await openSqliteState({
            schemaVersion: 1,
            stateDirectory: selected.root.path,
          });

          if (state.outcome !== 'opened') {
            render(state, options.json);

            return;
          }

          try {
            const provider = await hostExecutable('herdr', host.herdrExecutable);
            render(
              await initializeProject(
                { ...request, preview: false },
                compose(
                  state,
                  state.stateDirectory,
                  executable,
                  userSkillsRoot(options.userSkillsRoot),
                  provider,
                ),
              ),
              options.json,
            );
          } finally {
            state.store.close();
          }
        } finally {
          ownership.release();
        }
      } catch (error) {
        const failure = stateRejection(error);

        if (failure.error.code !== 'service_already_running') {
          render(failure, options.json);

          return;
        }

        const response = await requestLocalService(root, {
          schemaVersion: 1,
          operation: 'project_initialize',
          request: { ...request, preview: false },
          userSkillsRoot: userSkillsRoot(options.userSkillsRoot),
          gitExecutable: executable,
          herdrExecutable: await hostExecutable('herdr', host.herdrExecutable),
        });

        if (response.outcome === 'rejected') {
          render(response, options.json);

          return;
        }

        const parsed = initializationResultSchema.safeParse(
          response.outcome === 'completed' ? response.value : null,
        );
        render(
          parsed.success
            ? parsed.data
            : rejected(
                'service_protocol_error',
                'Service returned an invalid initialization result.',
              ),
          options.json,
        );
      }
    });
}
