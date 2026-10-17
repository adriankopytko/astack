import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openSqliteState,
  registerProject,
  createGitInspector,
  nodeProcessRunner,
  nodeCheckoutIdentityReader,
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
  submitServiceJob,
  type ServiceDependencies,
  type ServiceSubmitRequest,
  type ServiceJob,
} from '../../src/index.js';

export const gitPath = spawnSync('/usr/bin/which', ['git'], {
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
}).stdout.trim();
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(gitPath, ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

export async function fixture(
  action: (context: {
    root: string;
    state: string;
    sources: string[];
    deps: ServiceDependencies;
    opened: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>;
    request: (index: number, key: string, role?: string) => ServiceSubmitRequest;
    submit: (index: number, key: string, role?: string) => Promise<ServiceJob>;
    advance: () => void;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'asvc-')));
  const state = join(root, 's');
  const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: state });

  if (opened.outcome !== 'opened') {
    assert.fail(JSON.stringify(opened));
  }

  let sequence = 0;
  let now = 1000;
  const deps: ServiceDependencies = {
    registry: opened.registry,
    queue: opened.service,
    git: createGitInspector({ executable: gitPath, runner: nodeProcessRunner }),
    identity: nodeCheckoutIdentityReader,
    configuration: createNodeConfigurationReader(state),
    prerequisites: createNodeConfigurationProbe(() => false),
    now: () => now,
    nextId: (kind) => `${kind}-${String(++sequence).padStart(6, '0')}`,
  };
  const sources: string[] = [];
  const requests: ServiceSubmitRequest[] = [];

  try {
    await mkdir(join(state, 'config'), { mode: 0o700 });

    for (let index = 0; index < 3; index++) {
      const source = join(root, `p${index}`);
      sources.push(source);
      await mkdir(source);
      git(source, 'init', '-b', 'main');
      git(source, 'commit', '--allow-empty', '-m', 'fixture');
      const registration = await registerProject(
        { schemaVersion: 1, path: source, projectId: `project-${index}` },
        {
          ...deps,
          nextId: (kind) => `${kind}-${index}`,
          now: () => now,
        },
      );

      if (registration.outcome !== 'persisted') {
        assert.fail(JSON.stringify(registration));
      }

      const role = { runtime: 'fixture', command: 'fixture-worker' };
      await writeFile(
        join(state, 'config', `project-${index}.json`),
        JSON.stringify({
          schemaVersion: 1,
          projectId: registration.value.project.id,
          repositoryId: registration.value.repository.id,
          revision: 'v1',
          project: { roles: { implementer: role, reviewer: role } },
          execution: {
            enabled: true,
            allowedRuntimes: ['fixture'],
            allowedEnvironment: [],
            skills: [],
            commands: { 'fixture-worker': { executable: process.execPath, args: ['--version'] } },
          },
        }),
        { mode: 0o600 },
      );
      requests.push({
        schemaVersion: 1,
        projectId: registration.value.project.id,
        role: 'implementer',
        key: 'fixture',
        branch: 'refs/heads/main',
        commit: git(source, 'rev-parse', 'HEAD'),
        task: { description: 'fixture' },
        request: {},
      });
    }

    const request = (index: number, key: string, role = 'implementer'): ServiceSubmitRequest => {
      const base = requests[index];

      assert.ok(base);

      return { ...base, key, role };
    };

    await action({
      root,
      state,
      sources,
      deps,
      opened,
      request,
      submit: async (index, key, role) => {
        const result = await submitServiceJob(request(index, key, role), deps);

        if (result.outcome !== 'persisted') {
          assert.fail(JSON.stringify(result));
        }

        return result.value;
      },
      advance: () => {
        now += 100_000;
      },
    });
  } finally {
    opened.store.close();
    await rm(root, { recursive: true, force: true });
  }
}
