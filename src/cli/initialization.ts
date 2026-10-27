import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import {
  initializeProject,
  type InitializationDependencies,
} from '../application/initialization.js';
import type { InitializationResult } from '../contracts/initialization.js';
import { skillIdSchema, type SkillId } from '../contracts/skills.js';
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
  preview?: boolean;
  nonInteractive?: boolean;
  role: SkillId[];
  userSkillsRoot?: string;
  herdr?: boolean;
  herdrSession?: string;
  herdrSocket?: string;
  herdrLabel?: string;
  json?: boolean;
}
function render(result: InitializationResult, json?: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.outcome === 'rejected') {
    process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
  } else {
    const view = result.view;
    process.stdout.write(
      `Outcome: ${result.outcome}\nRoot: ${view.target.root}\nProject: ${view.target.projectId ?? 'registration required'}\nRegistration: ${view.registration}\nDelegation: ${view.delegation}\nProvider: ${view.provider.status}\n`,
    );

    for (const asset of view.assets) {
      process.stdout.write(
        `${asset.kind}: ${asset.state}${asset.reason ? ` (${asset.reason})` : ''}\n`,
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
      if (item.result.outcome === 'rejected') {
        process.stdout.write(`${item.role}: ${item.result.error.code}\n`);
      } else {
        for (const diagnostic of item.result.value.diagnostics) {
          process.stdout.write(`${item.role}: ${diagnostic.code} — ${diagnostic.nextStep}\n`);
        }
      }
    }

    for (const candidate of view.signals.suggestions) {
      process.stdout.write(
        `Suggested ${candidate.hook}: ${candidate.manager} run ${candidate.script} (declared script; not executed or approved)\n`,
      );
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
    configuration: createNodeConfigurationReader(root),
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
    hostRoot: root,
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
                  openWorker: async () =>
                    rejected('herdr_unavailable', 'Initialization never opens workers.'),
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
      'Initialize one explicit repository conservatively; never launch workers or execute detected scripts',
    )
    .option('--project <id>', 'Select an existing registered project from any caller directory')
    .option('--checkout <id>', 'Select an existing registered checkout; selectors must agree')
    .option('--id <id>', 'Assign a new project ID or assert the selected saved ID')
    .option('--preview', 'Read-only plan; no registration, files, state or provider setup')
    .option('--non-interactive', 'Report remaining decisions without prompts (also the default)')
    .option(
      '--role <role>',
      'Install selected project-local role skills; repeatable; default: none',
      (value: string, previous: SkillId[]) => {
        const parsed = skillIdSchema.safeParse(value);

        if (!parsed.success) {
          throw new InvalidArgumentError('Select orchestrator, implementer or reviewer.');
        }

        return [...previous, parsed.data];
      },
      [],
    )
    .option(
      '--user-skills-root <directory>',
      'Inspect global orchestrator availability at this root; never install globally',
    )
    .option('--herdr', 'Ensure the project primary space using its saved target')
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
          ? join(homedir(), '.local', 'state', 'astack')
          : resolve(process.cwd(), host.stateDirectory);
      const executable = await gitExecutable(host.gitExecutable);

      if (!executable) {
        render(rejected('git_unavailable', 'Select a trusted Git executable.'), options.json);

        return;
      }

      const request = {
        schemaVersion: 1,
        callerDirectory: process.cwd(),
        ...(path === undefined ? {} : { path: resolve(process.cwd(), path) }),
        ...(options.project === undefined ? {} : { projectId: options.project }),
        ...(options.checkout === undefined ? {} : { checkoutId: options.checkout }),
        ...(options.id === undefined ? {} : { assignProjectId: options.id }),
        skills: options.role,
        ...(options.herdr || options.herdrSession || options.herdrLabel
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

      if (options.preview || preview.outcome === 'rejected') {
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
            const provider = request.herdr
              ? await hostExecutable('herdr', host.herdrExecutable)
              : null;
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
        render(stateRejection(error), options.json);
      }
    });
}
