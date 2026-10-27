import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  stat,
  readdir,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  initializeProject,
  initializationResultSchema,
  nodeInitializationFiles,
  openSqliteState,
  acquireCoordinatorOwnership,
  createGitInspector,
  nodeProcessRunner,
  nodeCheckoutIdentityReader,
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
  nodeManagedFileStore,
  createNodeManagedFileStore,
  createBundledSkillReader,
  nodeSkillDirectories,
  createNodeWorktreeFiles,
  registerProject,
  inspectSkills,
  reconcileHerdrSpace,
  hostConfigurationPolicySchema,
  type InitializationDependencies,
  type InitializationResult,
} from '../src/index.js';
import { rejected } from '../src/contracts/operation-result.js';
import { fakeProvider } from './support/herdr.js';
import { git, gitPath } from './support/service.js';
import { metadataPaths } from '../src/core/managed-file-metadata.js';
const options = { timeout: 120000 };
const repo = fileURLToPath(new URL('../', import.meta.url));
function view(result: InitializationResult, outcome?: string) {
  initializationResultSchema.parse(result);

  assert.notEqual(result.outcome, 'rejected', JSON.stringify(result));

  if (result.outcome === 'rejected') {
    assert.fail(result.error.message);
  }

  if (outcome) {
    assert.equal(result.outcome, outcome, JSON.stringify(result));
  }

  return result.view;
}

async function fixture(
  action: (f: {
    root: string;
    source: string;
    state: string;
    deps: InitializationDependencies;
    fake: ReturnType<typeof fakeProvider>;
    opened: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astack-init-')));
  const source = join(root, 'repository');
  const state = join(root, 'state');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  git(source, 'commit', '--allow-empty', '-m', 'chore: fixture');
  const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: state });

  assert.ok(opened.outcome === 'opened');

  const ownership = await acquireCoordinatorOwnership(state);
  const fake = fakeProvider();
  let sequence = 0;
  const common = {
    registry: opened.registry,
    git: createGitInspector({ executable: gitPath, runner: nodeProcessRunner }),
    identity: nodeCheckoutIdentityReader,
    configuration: createNodeConfigurationReader(state),
    prerequisites: createNodeConfigurationProbe(() => false),
  };
  const deps: InitializationDependencies = {
    ...common,
    nextId: (kind) => `${kind}-init-${++sequence}`,
    now: () => 1000,
    files: nodeManagedFileStore,
    layout: nodeInitializationFiles,
    skills: {
      bundle: createBundledSkillReader(),
      files: nodeManagedFileStore,
      directories: nodeSkillDirectories,
    },
    userSkillsRoot: join(root, 'user-skills'),
    hostRoot: state,
    worktrees: opened.worktrees,
    herdr: {
      ...common,
      state: opened.store,
      herdr: opened.herdr,
      provider: fake.provider,
      files: createNodeWorktreeFiles(join(state, 'worktrees')),
      newId: () => `herdr-init-${++sequence}`,
    },
  };

  try {
    await action({ root, source, state, deps, fake, opened });
  } finally {
    opened.store.close();
    ownership.release();
    await rm(root, { recursive: true, force: true });
  }
}

await test(
  'preview is stable and read-only; fresh/repeated init keeps conservative policy and suggests only declared scripts',
  options,
  async () => {
    await fixture(async (f) => {
      const marker = join(f.root, 'project-code-must-not-run');
      const packageJson = JSON.stringify({
        packageManager: 'pnpm@11.24.0',
        scripts: {
          test: `node -e "require('fs').writeFileSync('${marker}', 'bad')"`,
          lint: 'some-real-project-lint',
          dev: 'custom-service',
        },
      });
      await writeFile(join(f.source, 'package.json'), packageJson);
      await writeFile(join(f.source, 'pnpm-lock.yaml'), 'x'.repeat(100000));
      await writeFile(join(f.source, 'AGENTS.md'), 'Authored project instructions\n');
      await writeFile(join(f.source, '.env'), 'SECRET=fixture-only-do-not-copy\n');
      await mkdir(join(f.source, 'nested'));
      const request = {
        schemaVersion: 1,
        callerDirectory: join(f.source, 'nested'),
        assignProjectId: 'project-init',
        skills: ['implementer', 'reviewer'],
      };
      const preview = await initializeProject({ ...request, preview: true }, f.deps);
      const first = view(preview, 'previewed');

      assert.deepEqual(await initializeProject({ ...request, preview: true }, f.deps), preview);
      assert.equal(first.target.root, f.source);
      assert.equal(first.registration, 'required');
      assert.deepEqual(
        first.signals.suggestions.map((item) => item.script),
        ['test', 'lint'],
      );
      assert.equal(first.signals.packageManager, 'pnpm');
      assert.equal(f.fake.calls.length, 0);

      await assert.rejects(access(join(f.source, '.astack')), { code: 'ENOENT' });
      await assert.rejects(access(join(f.state, 'config')), { code: 'ENOENT' });
      await assert.rejects(access(f.deps.userSkillsRoot), { code: 'ENOENT' });

      assert.doesNotMatch(
        JSON.stringify(preview),
        /fixture-only-do-not-copy|project-code-must-not-run|some-real-project-lint|custom-service/,
      );

      const applied = view(await initializeProject(request, f.deps), 'initialized');

      assert.equal(applied.target.projectId, 'project-init');
      assert.equal(applied.delegation, 'not_ready');
      assert.equal(applied.provider.status, 'not_selected');
      assert.ok(
        applied.configuration.every(
          (item) => item.result.outcome === 'completed' && item.result.value.status === 'blocked',
        ),
      );

      const policyPath = join(f.state, 'config', 'project-init.json');
      const policy = hostConfigurationPolicySchema.parse(
        JSON.parse(await readFile(policyPath, 'utf8')),
      );

      assert.equal(policy.execution.enabled, false);
      assert.deepEqual(policy.execution.commands, {});
      assert.deepEqual(policy.execution.allowedRuntimes, []);
      assert.equal((await stat(policyPath)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(f.source, '.agents', 'skills', 'astack-implementer', 'SKILL.md'))).mode &
          0o777,
        0o644,
      );
      assert.equal(
        await readFile(join(f.source, 'AGENTS.md'), 'utf8'),
        'Authored project instructions\n',
      );
      assert.equal(
        await readFile(join(f.source, '.env'), 'utf8'),
        'SECRET=fixture-only-do-not-copy\n',
      );
      assert.equal(await readFile(join(f.source, 'package.json'), 'utf8'), packageJson);

      await assert.rejects(access(marker), { code: 'ENOENT' });

      const proposal = join(f.source, '.astack', 'project.json');
      const inode = (await stat(proposal)).ino;
      const repeated = view(await initializeProject(request, f.deps), 'initialized');

      assert.equal(repeated.registration, 'registered');
      assert.equal(repeated.target.checkoutId, applied.target.checkoutId);
      assert.equal((await stat(proposal)).ino, inode);
      assert.ok(repeated.assets.every((asset) => asset.state === 'current'));
    });
  },
);

await test(
  'authored host setup, instructions and ignore files remain unchanged; init does not invent a conflicting proposal',
  options,
  async () => {
    await fixture(async (f) => {
      const registered = await registerProject(
        { schemaVersion: 1, path: f.source, projectId: 'existing-project' },
        f.deps,
      );

      assert.ok(registered.outcome === 'persisted');

      await mkdir(join(f.state, 'config'), { mode: 0o700 });
      const policy = hostConfigurationPolicySchema.parse({
        schemaVersion: 1,
        projectId: registered.value.project.id,
        repositoryId: registered.value.repository.id,
        revision: 'authored',
        project: { roles: { implementer: { runtime: 'codex-herdr' } } },
        execution: {
          enabled: true,
          allowedRuntimes: [],
          allowedEnvironment: [],
          commands: {},
          skills: [],
        },
      });
      const contents = `${JSON.stringify(policy)}\n`;
      await writeFile(join(f.state, 'config', 'existing-project.json'), contents, { mode: 0o600 });
      await mkdir(join(f.source, '.astack'));
      await writeFile(join(f.source, '.astack', '.gitignore'), '# Authored rules\n');
      const initialized = view(
        await initializeProject({ schemaVersion: 1, path: f.source }, f.deps),
        'initialized',
      );

      assert.equal(
        initialized.assets.find((asset) => asset.kind === 'proposal')?.reason,
        'existing_host_setup',
      );

      await assert.rejects(access(join(f.source, '.astack', 'project.json')), { code: 'ENOENT' });

      assert.equal(
        await readFile(join(f.state, 'config', 'existing-project.json'), 'utf8'),
        contents,
      );
      assert.equal(
        await readFile(join(f.source, '.astack', '.gitignore'), 'utf8'),
        '# Authored rules\n',
      );
    });
  },
);

await test(
  'edited managed proposals are preserved and unowned selected skills block without overwriting authored files',
  options,
  async () => {
    await fixture(async (f) => {
      const request = { schemaVersion: 1, path: f.source, assignProjectId: 'preserve-project' };
      view(await initializeProject(request, f.deps), 'initialized');
      const proposal = join(f.source, '.astack', 'project.json');
      await writeFile(proposal, '{"authored":"after-init"}\n');
      await mkdir(join(f.source, '.agents', 'skills', 'astack-reviewer'), { recursive: true });
      await writeFile(
        join(f.source, '.agents', 'skills', 'astack-reviewer', 'SKILL.md'),
        'Authored reviewer\n',
      );
      const result = view(
        await initializeProject({ ...request, skills: ['reviewer'] }, f.deps),
        'partial',
      );

      assert.equal(result.assets.find((asset) => asset.kind === 'proposal')?.state, 'preserved');
      assert.equal(await readFile(proposal, 'utf8'), '{"authored":"after-init"}\n');
      assert.equal(
        await readFile(join(f.source, '.agents', 'skills', 'astack-reviewer', 'SKILL.md'), 'utf8'),
        'Authored reviewer\n',
      );
      assert.equal(result.projectSkills?.outcome, 'blocked');
    });
  },
);

await test(
  'a partial directory failure retains registration and an explicit retry uses the same identity',
  options,
  async () => {
    await fixture(async (f) => {
      const request = { schemaVersion: 1, path: f.source, assignProjectId: 'retry-project' };
      const failed = view(
        await initializeProject(request, {
          ...f.deps,
          layout: {
            ...f.deps.layout,
            prepare: async (root, paths, signal) =>
              paths.includes('config')
                ? rejected('initialization_unavailable', 'Fixture directory failure')
                : f.deps.layout.prepare(root, paths, signal),
          },
        }),
        'partial',
      );

      assert.equal(failed.registration, 'created');

      const repeated = view(await initializeProject(request, f.deps), 'initialized');

      assert.equal(repeated.target.checkoutId, failed.target.checkoutId);
      assert.equal(repeated.target.repositoryId, failed.target.repositoryId);
      assert.equal(repeated.registration, 'registered');
    });
  },
);

await test(
  'pending asset publication stops init and retries preserve its journal instead of resending',
  options,
  async () => {
    await fixture(async (f) => {
      const store = createNodeManagedFileStore({
        onProgress: async (progress) => {
          if (progress.phase === 'prepared' && progress.intent.after.path === 'project.json') {
            throw new Error('private fixture interruption');
          }
        },
      });
      const request = { schemaVersion: 1, path: f.source, assignProjectId: 'pending-project' };
      const partial = view(
        await initializeProject(request, { ...f.deps, files: store }),
        'partial',
      );
      const proposal = partial.assets.find((asset) => asset.kind === 'proposal');

      assert.equal(proposal?.state, 'pending');
      assert.doesNotMatch(JSON.stringify(partial), /private fixture interruption/);

      const metadata = join(f.source, '.astack', '.astack-managed');
      const names = await readdir(metadata);
      const repeat = view(await initializeProject(request, f.deps), 'partial');

      assert.equal(repeat.assets.find((asset) => asset.kind === 'proposal')?.state, 'pending');
      assert.deepEqual(await readdir(metadata), names);
      assert.equal(f.fake.calls.length, 0);

      git(f.source, 'check-ignore', '-q', `.astack/${metadataPaths('project.json').pending}`);
    });
  },
);

await test(
  'Herdr setup is explicit and durable; uncertain creation never replays on init retry',
  options,
  async () => {
    await fixture(async (f) => {
      const request = {
        schemaVersion: 1,
        path: f.source,
        assignProjectId: 'provider-project',
        herdr: { target: { session: 'fixture', socketPath: join(f.root, 'fixture.sock') } },
      };
      f.fake.modes.create = 'after';
      const pending = view(await initializeProject(request, f.deps), 'partial');

      assert.equal(pending.provider.status, 'pending');
      assert.equal(f.fake.calls.filter((call) => call.operation === 'create').length, 1);
      assert.equal(f.fake.calls.filter((call) => call.operation === 'open').length, 0);

      const repeated = view(await initializeProject(request, f.deps), 'partial');

      assert.equal(repeated.provider.status, 'pending');
      assert.equal(f.fake.calls.filter((call) => call.operation === 'create').length, 1);

      const record = f.opened.herdr.primary('provider-project');

      assert.ok(record.outcome === 'completed' && record.value);

      const reconciled = await reconcileHerdrSpace(
        {
          schemaVersion: 1,
          id: record.value.id,
          operationId: record.value.operationId,
          writerStopped: true,
        },
        f.deps.herdr!,
      );

      assert.equal(reconciled.outcome, 'reconciled', JSON.stringify(reconciled));

      const completed = view(await initializeProject(request, f.deps), 'initialized');

      assert.equal(completed.provider.status, 'ready');

      const conflict = view(
        await initializeProject(
          {
            ...request,
            herdr: { target: { session: 'different', socketPath: join(f.root, 'another.sock') } },
          },
          f.deps,
        ),
        'partial',
      );

      assert.equal(conflict.provider.status, 'blocked');
      assert.equal(conflict.provider.settings?.target.session, 'fixture');
      assert.equal(f.fake.calls.filter((call) => call.operation === 'create').length, 1);
    });
  },
);

await test(
  'linked checkouts keep distinct identity, use the saved primary space and retain Git-trackable skill provenance',
  options,
  async () => {
    await fixture(async (f) => {
      const linked = join(f.root, 'linked');
      git(f.source, 'worktree', 'add', '-b', 'linked-init', linked, 'HEAD');
      const before = await initializeProject(
        { schemaVersion: 1, path: linked, preview: true },
        f.deps,
      );

      assert.ok(
        before.outcome === 'rejected' && before.error.code === 'project_registration_conflict',
      );

      const main = view(
        await initializeProject(
          {
            schemaVersion: 1,
            path: f.source,
            assignProjectId: 'linked-project',
            skills: ['implementer'],
          },
          f.deps,
        ),
        'initialized',
      );
      git(f.source, 'add', '.astack', '.agents');
      git(f.source, 'commit', '-m', 'chore: keep initialized project assets');
      git(linked, 'merge', '--ff-only', 'main');
      await mkdir(join(linked, 'subdirectory'));
      const initialized = view(
        await initializeProject(
          {
            schemaVersion: 1,
            callerDirectory: join(linked, 'subdirectory'),
            skills: ['implementer'],
            herdr: { target: { session: 'linked', socketPath: join(f.root, 'linked.sock') } },
          },
          f.deps,
        ),
        'initialized',
      );

      assert.equal(initialized.target.projectId, main.target.projectId);
      assert.notEqual(initialized.target.checkoutId, main.target.checkoutId);
      assert.equal(initialized.target.root, linked);
      assert.equal(initialized.target.linked, true);
      assert.equal(f.fake.calls.find((call) => call.operation === 'create')?.root, f.source);
      assert.equal(initialized.projectSkills?.outcome, 'unchanged');
      assert.equal(git(linked, 'status', '--porcelain'), '');

      const skillState = await inspectSkills(
        {
          schemaVersion: 1,
          root: join(linked, '.agents', 'skills'),
          skills: ['implementer'],
          mode: 0o644,
        },
        f.deps.skills,
      );

      assert.ok(skillState.outcome === 'completed' && skillState.value.available);
    });
  },
);

await test(
  'a symlinked project skills parent cannot escape even during preview',
  options,
  async () => {
    await fixture(async (f) => {
      const outside = join(f.root, 'outside');
      await mkdir(join(outside, 'skills'), { recursive: true });
      await symlink(outside, join(f.source, '.agents'));
      const preview = view(
        await initializeProject(
          { schemaVersion: 1, path: f.source, skills: ['reviewer'], preview: true },
          f.deps,
        ),
        'previewed',
      );

      assert.equal(preview.projectSkills?.outcome, 'rejected');

      const partial = view(
        await initializeProject({ schemaVersion: 1, path: f.source, skills: ['reviewer'] }, f.deps),
        'partial',
      );

      assert.equal(partial.registration, 'required');
      assert.deepEqual(await readdir(join(outside, 'skills')), []);

      await assert.rejects(access(join(f.source, '.astack')), { code: 'ENOENT' });
    });
  },
);

await test(
  'packed init preview and neutral-directory failure create no state; noninteractive init remains conservative',
  options,
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astack-init-cli-')));

    try {
      const source = join(root, 'repository');
      const state = join(root, 'state');
      const userSkills = join(root, 'user-skills');
      await mkdir(source);
      git(source, 'init', '-b', 'main');
      git(source, 'commit', '--allow-empty', '-m', 'chore: fixture');
      const archive = join(root, 'astack.tgz');
      const packed = spawnSync('pnpm', ['pack', '--out', archive], { cwd: repo, encoding: 'utf8' });

      assert.equal(packed.status, 0, packed.stderr);

      const extracted = spawnSync('tar', ['-xzf', archive, '-C', root], { encoding: 'utf8' });

      assert.equal(extracted.status, 0, extracted.stderr);

      await symlink(join(repo, 'node_modules'), join(root, 'package', 'node_modules'));
      const entry = join(root, 'package', 'dist', 'cli', 'main.js');
      const call = (args: string[], cwd = root) =>
        spawnSync(
          process.execPath,
          [
            entry,
            '--state-directory',
            state,
            'init',
            '--user-skills-root',
            userSkills,
            ...args,
            '--json',
          ],
          { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      const preview = call([source, '--preview']);

      assert.equal(preview.status, 0, preview.stderr);

      view(initializationResultSchema.parse(JSON.parse(preview.stdout)), 'previewed');
      await assert.rejects(access(state), { code: 'ENOENT' });
      await assert.rejects(access(userSkills), { code: 'ENOENT' });
      await assert.rejects(access(join(source, '.astack')), { code: 'ENOENT' });
      const neutral = call(['--non-interactive']);

      assert.equal(neutral.status, 1);

      const failed = initializationResultSchema.parse(JSON.parse(neutral.stdout));

      assert.ok(failed.outcome === 'rejected' && failed.error.code === 'project_context_required');

      await assert.rejects(access(state), { code: 'ENOENT' });
      const initialized = call([
        source,
        '--id',
        'packed-project',
        '--non-interactive',
        '--role',
        'reviewer',
      ]);

      assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);

      const actual = view(
        initializationResultSchema.parse(JSON.parse(initialized.stdout)),
        'initialized',
      );

      assert.equal(actual.target.projectId, 'packed-project');
      assert.equal(actual.delegation, 'not_ready');

      const readonly = call(['--project', 'packed-project', '--preview']);

      assert.equal(readonly.status, 0, readonly.stderr);
      assert.equal(
        view(initializationResultSchema.parse(JSON.parse(readonly.stdout))).target.root,
        source,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

await test(
  'invalid/cancelled initialization performs no setup; HEAD drift stops before publication',
  options,
  async () => {
    await fixture(async (f) => {
      const cancelled = await initializeProject(
        { schemaVersion: 1, path: f.source },
        f.deps,
        AbortSignal.abort(),
      );

      assert.ok(cancelled.outcome === 'rejected' && cancelled.error.code === 'cancelled');

      const invalid = await initializeProject(
        { schemaVersion: 1, path: f.source, skills: ['unknown'] },
        f.deps,
      );

      assert.ok(invalid.outcome === 'rejected' && invalid.error.code === 'invalid_request');

      await assert.rejects(access(join(f.source, '.astack')), { code: 'ENOENT' });
      let changed = false;
      const result = view(
        await initializeProject(
          { schemaVersion: 1, path: f.source },
          {
            ...f.deps,
            layout: {
              ...f.deps.layout,
              prepare: async (...args) => {
                const result = await f.deps.layout.prepare(...args);

                if (!changed) {
                  git(f.source, 'commit', '--allow-empty', '-m', 'chore: concurrent change');
                  changed = true;
                }

                return result;
              },
            },
          },
        ),
        'partial',
      );

      assert.equal(result.registration, 'created');
      assert.ok(result.diagnostics.some((item) => item.code === 'project_checkout_stale'));

      await assert.rejects(access(join(f.source, '.astack', 'project.json')), { code: 'ENOENT' });

      assert.equal(f.fake.calls.length, 0);
    });
  },
);

await test(
  'missing explicit provider target retains successful setup without contacting a provider',
  options,
  async () => {
    await fixture(async (f) => {
      const result = view(
        await initializeProject({ schemaVersion: 1, path: f.source, herdr: {} }, f.deps),
        'partial',
      );

      assert.equal(result.registration, 'created');
      assert.equal(result.provider.status, 'blocked');
      assert.ok(result.diagnostics.some((item) => item.code === 'herdr_target_required'));
      assert.equal(f.fake.calls.length, 0);

      await access(join(f.source, '.astack', 'project.json'));
    });
  },
);
