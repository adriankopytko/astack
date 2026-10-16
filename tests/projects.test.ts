import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  registerProject,
  selectProjectContext,
  listProjects,
  openSqliteState,
  createGitInspector,
  nodeProcessRunner,
  nodeCheckoutIdentityReader,
  projectRegistrationResultSchema,
  projectSelectionResultSchema,
  projectListResultSchema,
  acceptStateJob,
  prepareStateAttempt,
  type ProjectRegistration,
  type ProjectDependencies,
  type ProjectRegistrationDependencies,
} from '../src/index.js';
import { emptyProjectRegistry } from '../src/adapters/state/empty-project-registry.js';
import { stateMigrations } from '../src/adapters/state/migrations.js';
import { stateApplicationId } from '../src/adapters/state/database.js';

const gitPath = spawnSync('/usr/bin/which', ['git'], {
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
}).stdout.trim();
const options = { timeout: 60_000 };
const gitInspector = createGitInspector({
  executable: gitPath,
  runner: nodeProcessRunner,
  timeoutMs: 20_000,
});
const cliPath = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

function git(cwd: string, ...args: string[]): string {
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

async function repository(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  git(root, 'init', '--initial-branch=main');
  await writeFile(join(root, 'tracked.txt'), 'fixture\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'fixture');

  return root;
}

async function fixture(
  check: (
    root: string,
    dependencies: ProjectRegistrationDependencies,
    statePath: string,
  ) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astack projects ')));
  const statePath = join(root, 'state');
  const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: statePath });

  assert.equal(opened.outcome, 'opened');

  if (opened.outcome !== 'opened') {
    assert.fail('Expected opened state');
  }

  let sequence = 0;
  const dependencies: ProjectRegistrationDependencies = {
    registry: opened.registry,
    git: gitInspector,
    identity: nodeCheckoutIdentityReader,
    now: () => 1000,
    nextId: (kind) => `${kind}-${++sequence}`,
  };

  try {
    await check(root, dependencies, statePath);
  } finally {
    opened.store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function register(
  path: string,
  dependencies: ProjectRegistrationDependencies,
  projectId?: string,
): Promise<ProjectRegistration> {
  const result = projectRegistrationResultSchema.parse(
    await registerProject(
      { schemaVersion: 1, path, ...(projectId === undefined ? {} : { projectId }) },
      dependencies,
    ),
  );

  if (result.outcome !== 'persisted') {
    assert.fail(result.error.code);
  }

  return result.value;
}

async function context(input: object, dependencies: ProjectDependencies) {
  const result = projectSelectionResultSchema.parse(
    await selectProjectContext({ schemaVersion: 1, ...input }, dependencies),
  );

  if (result.outcome !== 'completed') {
    assert.fail(result.error.code);
  }

  return result.value;
}

function errorCode(result: { outcome: string; error?: { code: string } }): string | undefined {
  assert.equal(result.outcome, 'rejected');

  return result.error?.code;
}

function cli(cwd: string, statePath: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cliPath, '--state-directory', statePath, '--git-executable', gitPath, ...args, '--json'],
    { cwd, env: {}, encoding: 'utf8', timeout: 15_000 },
  );

  assert.equal(result.stderr, '');

  const value: unknown = JSON.parse(result.stdout);

  return { ...result, value };
}

await test(
  'registration is explicit, repeatable and keeps independent clone and basename identities separate',
  options,
  async () => {
    await fixture(async (root, deps) => {
      const first = await repository(join(root, 'left/shared'));
      const second = await repository(join(root, 'right/shared'));
      const initial = await context({ path: first }, deps);

      assert.equal(initial.registration, 'unregistered-repository');
      assert.equal(initial.project, null);

      const a = await register(first, deps);
      const repeated = await register(first, deps);
      const b = await register(second, deps);
      const clone = join(root, 'clone');
      git(root, 'clone', '--no-hardlinks', first, clone);
      const c = await register(clone, deps);

      assert.deepEqual(repeated, a);
      assert.notEqual(a.project.id, b.project.id);
      assert.notEqual(a.project.id, c.project.id);
      assert.notEqual(a.repository.id, c.repository.id);
      assert.equal(
        errorCode(
          await registerProject({ schemaVersion: 1, path: second, projectId: a.project.id }, deps),
        ),
        'project_registration_conflict',
      );

      const list = projectListResultSchema.parse(
        await listProjects({ schemaVersion: 1, limit: 2 }, deps.registry),
      );

      assert.equal(list.outcome, 'completed');

      if (list.outcome === 'completed') {
        assert.equal(list.value.items.length, 2);
        assert.ok(list.value.nextCursor);

        const next = await listProjects(
          { schemaVersion: 1, after: list.value.nextCursor, limit: 2 },
          deps.registry,
        );

        assert.equal(next.outcome === 'completed' && next.value.items.length, 1);
      }
    });
  },
);

await test(
  'linked checkouts register under the same project without changing its primary checkout',
  options,
  async () => {
    await fixture(async (root, deps) => {
      const primary = await repository(join(root, 'primary'));
      const a = await register(primary, deps, 'chosen-project');
      const linked = join(root, 'worker');
      git(primary, 'worktree', 'add', '-b', 'worker', linked);
      const pending = await context({ path: linked }, deps);

      assert.equal(pending.registration, 'unregistered-checkout');
      assert.equal(pending.project?.project.id, a.project.id);
      assert.equal(pending.checkout, null);

      const b = await register(linked, deps);

      assert.equal(b.project.id, a.project.id);
      assert.equal(b.repository.id, a.repository.id);
      assert.notEqual(b.checkout.id, a.checkout.id);
      assert.equal(b.project.primaryCheckoutId, a.checkout.id);

      const explicit = await context({ projectId: a.project.id, callerDirectory: root }, deps);
      const worker = await context({ projectId: a.project.id, path: linked }, deps);

      assert.equal(explicit.checkout?.checkout.id, a.checkout.id);
      assert.equal(explicit.source, 'explicit-project');
      assert.equal(worker.checkout?.checkout.id, b.checkout.id);
      assert.equal(worker.registration, 'registered');
    });
  },
);

await test(
  'nearest nested repository wins and explicit targets work from neutral and unrelated contexts',
  options,
  async () => {
    await fixture(async (root, deps) => {
      const parent = await repository(join(root, 'parent'));
      const nested = await repository(join(parent, 'nested'));
      const a = await register(parent, deps);
      const b = await register(nested, deps);
      await mkdir(join(nested, 'src'));
      const selected = await context({ callerDirectory: join(nested, 'src') }, deps);
      const targeted = await context({ projectId: b.project.id, callerDirectory: parent }, deps);

      assert.equal(selected.project?.project.id, b.project.id);
      assert.equal(selected.source, 'caller-directory');
      assert.equal(targeted.project?.project.id, b.project.id);
      assert.equal(
        errorCode(await selectProjectContext({ schemaVersion: 1, callerDirectory: root }, deps)),
        'project_context_required',
      );
      assert.equal(
        errorCode(
          await selectProjectContext(
            { schemaVersion: 1, projectId: a.project.id, checkoutId: b.checkout.id },
            deps,
          ),
        ),
        'project_selector_conflict',
      );
      assert.equal(
        errorCode(
          await selectProjectContext(
            { schemaVersion: 1, projectId: a.project.id, path: nested },
            deps,
          ),
        ),
        'project_selector_conflict',
      );
      assert.equal(targeted.readiness.delegation, 'unavailable');
      assert.equal(targeted.readiness.providers.codex, 'not_checked');
      assert.equal(targeted.readiness.configuration.source, 'none');
    });
  },
);

await test(
  'saved attempts bind project and checkout and keep assigned commits distinct from observed HEAD',
  options,
  async () => {
    await fixture(async (root, deps, statePath) => {
      const path = await repository(join(root, 'repo'));
      const registered = await register(path, deps);
      const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: statePath });

      assert.equal(opened.outcome, 'opened');

      if (opened.outcome !== 'opened') {
        assert.fail('Expected opened state');
      }

      try {
        const commit = git(path, 'rev-parse', 'HEAD');
        const job = acceptStateJob(
          {
            schemaVersion: 1,
            job: {
              id: 'job',
              projectId: registered.project.id,
              repositoryId: registered.repository.id,
              checkoutId: registered.checkout.id,
              requester: 'host',
              operation: 'implementation',
              idempotencyKey: 'task',
              createdAt: 1000,
              intent: { task: 'fixture' },
            },
          },
          opened.store,
        );

        assert.equal(job.outcome, 'persisted');
        assert.equal(
          prepareStateAttempt(
            {
              schemaVersion: 1,
              attempt: {
                id: 'saved-attempt',
                jobId: 'job',
                number: 1,
                branch: 'refs/heads/main',
                commit,
                createdAt: 1000,
              },
              effects: [
                {
                  id: 'effect',
                  attemptId: 'saved-attempt',
                  kind: 'launch',
                  key: 'worker',
                  createdAt: 1000,
                  payload: {},
                },
              ],
            },
            opened.store,
          ).outcome,
          'persisted',
        );

        await writeFile(join(path, 'tracked.txt'), 'worker commit\n');
        git(path, 'commit', '-am', 'worker');
        const run = await context({ runId: 'saved-attempt', callerDirectory: root }, deps);

        assert.equal(run.source, 'saved-run');
        assert.equal(run.run?.commit, commit);
        assert.notEqual(run.git.checkout.head.commit, commit);
        assert.equal(
          errorCode(
            await selectProjectContext(
              { schemaVersion: 1, runId: 'saved-attempt', projectId: 'other' },
              deps,
            ),
          ),
          'project_selector_conflict',
        );
        assert.equal(
          errorCode(await selectProjectContext({ schemaVersion: 1, runId: 'missing' }, deps)),
          'run_not_found',
        );
      } finally {
        opened.store.close();
      }
    });
  },
);

await test(
  'moved and replaced checkouts never silently inherit recorded identities',
  options,
  async () => {
    await fixture(async (root, deps) => {
      const path = await repository(join(root, 'repo'));
      const registered = await register(path, deps);
      const moved = join(root, 'moved');
      await rename(path, moved);

      assert.equal(
        errorCode(
          await selectProjectContext({ schemaVersion: 1, projectId: registered.project.id }, deps),
        ),
        'project_checkout_stale',
      );
      assert.equal((await context({ path: moved }, deps)).registration, 'unregistered-repository');
      assert.equal(
        errorCode(
          await registerProject(
            { schemaVersion: 1, path: moved, projectId: registered.project.id },
            deps,
          ),
        ),
        'project_checkout_stale',
      );

      await repository(path);

      assert.equal(
        errorCode(await selectProjectContext({ schemaVersion: 1, callerDirectory: path }, deps)),
        'project_checkout_stale',
      );
      assert.equal(
        errorCode(await registerProject({ schemaVersion: 1, path }, deps)),
        'project_checkout_stale',
      );
    });
  },
);

await test(
  'CLI registration, context and doctor use explicit state; diagnostics do not initialize state',
  options,
  async () => {
    await fixture(async (root, _deps, statePath) => {
      const path = await repository(join(root, 'repo'));
      const absent = join(root, 'absent-state');
      const diagnostic = cli(path, absent, 'doctor');

      assert.equal(diagnostic.status, 0);
      assert.equal(projectSelectionResultSchema.parse(diagnostic.value).outcome, 'completed');

      await assert.rejects(lstat(absent), { code: 'ENOENT' });
      const registration = cli(root, statePath, 'project', 'register', path, '--id', 'cli-project');
      const receipt = projectRegistrationResultSchema.parse(registration.value);

      assert.equal(registration.status, 0);
      assert.equal(receipt.outcome, 'persisted');

      const selected = cli(root, statePath, 'context', '--project', 'cli-project');
      const result = projectSelectionResultSchema.parse(selected.value);

      assert.equal(selected.status, 0);
      assert.equal(result.outcome === 'completed' && result.value.source, 'explicit-project');

      const listing = cli(root, statePath, 'project', 'list');

      assert.equal(projectListResultSchema.parse(listing.value).outcome, 'completed');

      const collection = cli(root, statePath, 'context');

      assert.equal(collection.status, 1);
      assert.equal(
        errorCode(projectSelectionResultSchema.parse(collection.value)),
        'project_context_required',
      );
    });
  },
);

await test(
  'read-only state blocks writes, does not bootstrap missing state, and rejects incomplete layouts',
  options,
  async () => {
    await fixture(async (root, deps, statePath) => {
      const path = await repository(join(root, 'repo'));
      const registration = await register(path, deps);
      const read = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: statePath,
        mode: 'read-only',
      });

      assert.equal(read.outcome, 'opened');

      if (read.outcome !== 'opened') {
        assert.fail('Expected opened read-only state');
      }

      try {
        assert.equal(errorCode(read.registry.register(registration)), 'state_read_only');
        assert.equal(
          (await listProjects({ schemaVersion: 1 }, read.registry)).outcome,
          'completed',
        );
      } finally {
        read.store.close();
      }

      const missing = join(root, 'missing');

      assert.equal(
        errorCode(
          await openSqliteState({ schemaVersion: 1, stateDirectory: missing, mode: 'read-only' }),
        ),
        'state_not_found',
      );

      await assert.rejects(lstat(missing), { code: 'ENOENT' });
      const incomplete = join(root, 'incomplete');
      await mkdir(incomplete, { mode: 0o700 });
      await writeFile(
        join(incomplete, '.astack-state.json'),
        JSON.stringify({ schemaVersion: 1, kind: 'astack-state', id: randomUUID() }),
        { mode: 0o600 },
      );

      assert.equal(
        errorCode(
          await openSqliteState({
            schemaVersion: 1,
            stateDirectory: incomplete,
            mode: 'read-only',
          }),
        ),
        'state_directory_unsafe',
      );
    });
  },
);

await test(
  'migration two upgrades existing state without changing the first migration or adopting projections',
  options,
  async () => {
    await fixture(async (root) => {
      const statePath = join(root, 'version-one');
      await mkdir(statePath, { mode: 0o700 });
      await writeFile(
        join(statePath, '.astack-state.json'),
        JSON.stringify({ schemaVersion: 1, kind: 'astack-state', id: randomUUID() }),
        { mode: 0o600 },
      );
      const databasePath = join(statePath, 'state.sqlite');
      const db = new DatabaseSync(databasePath);
      const first = stateMigrations[0];
      db.exec(first.sql);
      db.prepare('INSERT INTO state_migrations(version, checksum) VALUES (?, ?)').run(
        1,
        createHash('sha256').update(first.sql).digest('hex'),
      );
      db.exec(`PRAGMA application_id=${stateApplicationId}; PRAGMA user_version=1;`);
      db.close();
      await chmod(databasePath, 0o600);

      assert.equal(
        errorCode(
          await openSqliteState({ schemaVersion: 1, stateDirectory: statePath, mode: 'read-only' }),
        ),
        'state_schema_mismatch',
      );

      const upgraded = await openSqliteState({ schemaVersion: 1, stateDirectory: statePath });

      assert.equal(upgraded.outcome, 'opened');

      if (upgraded.outcome === 'opened') {
        try {
          assert.equal(
            (await listProjects({ schemaVersion: 1 }, upgraded.registry)).outcome,
            'completed',
          );
        } finally {
          upgraded.store.close();
        }
      }
    });
  },
);

await test('invalid and cancelled project requests do not consult providers', options, async () => {
  let calls = 0;
  const deps: ProjectRegistrationDependencies = {
    registry: emptyProjectRegistry,
    git: {
      inspect: () => {
        calls++;

        throw new Error('private');
      },
    },
    identity: nodeCheckoutIdentityReader,
    nextId: () => {
      calls++;

      return 'id';
    },
    now: () => 1000,
  };

  assert.equal(
    errorCode(await registerProject({ schemaVersion: 1, path: 'relative' }, deps)),
    'invalid_request',
  );
  assert.equal(
    errorCode(await selectProjectContext({ schemaVersion: 1 }, deps)),
    'invalid_request',
  );
  assert.equal(
    errorCode(await selectProjectContext({ schemaVersion: 2, callerDirectory: '/work' }, deps)),
    'unsupported_contract_version',
  );

  const controller = new AbortController();
  controller.abort();

  assert.equal(
    errorCode(await registerProject({ schemaVersion: 1, path: '/work' }, deps, controller.signal)),
    'cancelled',
  );
  assert.equal(calls, 0);
});
