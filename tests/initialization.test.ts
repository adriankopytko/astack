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
import { spawn, spawnSync } from 'node:child_process';
import {
  initializeProject,
  startLocalService,
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
  resolveConfiguration,
  submitServiceJob,
  checkConfigurationDispatch,
  inspectSkills,
  reconcileHerdrSpace,
  projectConfigurationFileSchema,
  type InitializationDependencies,
  type InitializationResult,
} from '../src/index.js';
import { rejected } from '../src/contracts/operation-result.js';
import { requestLocalService } from '../src/adapters/local/service-client.js';
import { fakeProvider } from './support/herdr.js';
import { git, gitPath } from './support/service.js';
import { metadataPaths } from '../src/core/managed-file-metadata.js';
const options = { timeout: 120000 };

await test('project agent configuration requires model and reasoning and does not accept skill pins', () => {
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: {
        implementer: {
          provider: 'codex',
          model: 'example',
          reasoning: 'high',
          hooks: { before: 'pnpm install', after: 'pnpm stop' },
          ports: { APP_PORT: { range: [20000, 20010] }, OAUTH_PORT: { fixed: 3000 } },
        },
      },
    }).success,
    true,
  );
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: {
        implementer: {
          provider: 'codex',
          model: 'example',
          reasoning: 'high',
          ports: { APP_PORT: { range: [20010, 20000] } },
        },
      },
    }).success,
    false,
  );
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: { implementer: { provider: 'codex', reasoning: 'high' } },
    }).success,
    false,
  );
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: { implementer: { provider: 'codex', model: 'example' } },
    }).success,
    false,
  );
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: {},
      execution: { skills: [] },
    }).success,
    false,
  );
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: {},
      execution: { verification: {} },
    }).success,
    false,
  );
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: {},
      hooks: { setup: 'old-command' },
    }).success,
    false,
  );
  assert.equal(
    projectConfigurationFileSchema.safeParse({
      schemaVersion: 1,
      agents: {},
      execution: { hooks: {} },
    }).success,
    false,
  );
});
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
    ownership: Awaited<ReturnType<typeof acquireCoordinatorOwnership>>;
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
    configuration: createNodeConfigurationReader(opened.registry, opened.store),
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
    defaultHerdrTarget: { session: 'default', socketPath: join(root, 'default.sock') },
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
    await action({ root, source, state, deps, fake, opened, ownership });
  } finally {
    opened.store.close();
    ownership.release();
    await rm(root, { recursive: true, force: true });
  }
}

await test('init uses the running service without interrupting it', options, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astack-init-live-')));
  const source = join(root, 'repository');
  const state = join(root, 'state');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  git(source, 'commit', '--allow-empty', '-m', 'chore: fixture');
  const fake = fakeProvider();
  const service = await startLocalService(
    { schemaVersion: 1, stateDirectory: state, gitExecutable: gitPath },
    { initializationHerdrProvider: fake.provider },
  );

  assert.equal(service.outcome, 'listening', JSON.stringify(service));

  if (service.outcome !== 'listening') {
    await rm(root, { recursive: true, force: true });

    return;
  }

  try {
    const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        '--state-directory',
        state,
        '--git-executable',
        gitPath,
        '--herdr-executable',
        '/nonexistent/herdr',
        'init',
        source,
        '--herdr-session',
        'fixture',
        '--herdr-socket',
        join(root, 'missing.sock'),
        '--json',
      ]);
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    });
    const initialized = view(
      initializationResultSchema.parse(JSON.parse(result.stdout)),
      'initialized',
    );

    assert.equal(result.code, 0, result.stdout);
    assert.equal(initialized.registration, 'created');
    assert.equal(initialized.provider.status, 'ready');
    assert.ok(fake.calls.some((call) => call.operation === 'create'));

    await access(join(source, '.astack', 'config.json'));
    const status = await requestLocalService(state, { schemaVersion: 1, operation: 'status' });

    assert.equal(status.outcome, 'completed');
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test(
  'init infers the project ID and detects collisions before applying',
  options,
  async () => {
    await fixture(async (f) => {
      const initialized = view(
        await initializeProject({ schemaVersion: 1, path: f.source }, f.deps),
        'initialized',
      );

      assert.equal(initialized.target.projectId, 'repository');

      const other = join(f.root, 'other', 'repository');
      await mkdir(other, { recursive: true });
      git(other, 'init', '-b', 'main');
      git(other, 'commit', '--allow-empty', '-m', 'chore: fixture');
      const collision = await initializeProject(
        { schemaVersion: 1, path: other, preview: true },
        f.deps,
      );

      assert.equal(collision.outcome, 'rejected');

      if (collision.outcome === 'rejected') {
        assert.equal(collision.error.code, 'project_registration_conflict');
        assert.match(collision.error.message, /--id/);
      }
    });
  },
);

await test(
  'preview is stable and read-only; fresh/repeated init keeps conservative policy without detecting project tooling',
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
      assert.ok(first.diagnostics.some((item) => item.code === 'project_configuration'));
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
      assert.equal(applied.provider.status, 'ready');
      assert.ok(
        applied.provider.result &&
          'record' in applied.provider.result &&
          applied.provider.result.outcome === 'prepared',
      );
      assert.equal(applied.provider.result.record?.label, 'repository');
      assert.ok(
        applied.configuration.every(
          (item) => item.result.outcome === 'completed' && item.result.value.status === 'blocked',
        ),
      );

      for (const item of applied.configuration) {
        assert.ok(item.result.outcome === 'completed');
        assert.ok(
          item.result.value.diagnostics.some((entry) => entry.code === 'agent_model_missing'),
        );
        assert.ok(
          item.result.value.diagnostics.some((entry) => entry.code === 'agent_reasoning_missing'),
        );
      }

      const policyPath = join(f.source, '.astack', 'config.json');
      const config = JSON.parse(await readFile(policyPath, 'utf8')) as {
        agents: Record<
          string,
          { provider: string; model: string | null; reasoning: string | null }
        >;
      };

      assert.deepEqual(config.agents.implementer, {
        provider: 'codex',
        model: null,
        reasoning: null,
        permissions: { files: 'write' },
      });
      assert.deepEqual(config.agents.reviewer, {
        provider: 'codex',
        model: null,
        reasoning: null,
        permissions: { files: 'readonly' },
      });
      assert.equal((await stat(policyPath)).mode & 0o777, 0o644);

      await assert.rejects(access(join(f.state, 'config', 'project-init.json')), {
        code: 'ENOENT',
      });

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

      const proposal = join(f.source, '.astack', 'config.json');
      const inode = (await stat(proposal)).ino;
      const repeated = view(await initializeProject(request, f.deps), 'initialized');

      assert.equal(repeated.registration, 'registered');
      assert.ok(repeated.provider.result && repeated.provider.result.outcome === 'reused');
      assert.equal(f.fake.calls.filter((call) => call.operation === 'create').length, 1);
      assert.equal(repeated.target.checkoutId, applied.target.checkoutId);
      assert.equal((await stat(proposal)).ino, inode);
      assert.ok(repeated.assets.every((asset) => asset.state === 'current'));
    });
  },
);

await test(
  'authored ignore rules remain untouched while init creates project configuration',
  options,
  async () => {
    await fixture(async (f) => {
      await mkdir(join(f.source, '.astack'));
      await writeFile(join(f.source, '.astack', '.gitignore'), '# Authored rules\n');
      const initialized = view(
        await initializeProject({ schemaVersion: 1, path: f.source }, f.deps),
        'initialized',
      );

      assert.equal(
        initialized.assets.find((asset) => asset.kind === 'project-config')?.state,
        'written',
      );

      await access(join(f.source, '.astack', 'config.json'));

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
      const proposal = join(f.source, '.astack', 'config.json');
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

      assert.equal(
        result.assets.find((asset) => asset.kind === 'project-config')?.state,
        'preserved',
      );
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
              paths.includes('.astack')
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
          if (progress.phase === 'prepared' && progress.intent.after.path === 'config.json') {
            throw new Error('private fixture interruption');
          }
        },
      });
      const request = { schemaVersion: 1, path: f.source, assignProjectId: 'pending-project' };
      const partial = view(
        await initializeProject(request, { ...f.deps, files: store }),
        'partial',
      );
      const proposal = partial.assets.find((asset) => asset.kind === 'project-config');

      assert.equal(proposal?.state, 'pending');
      assert.doesNotMatch(JSON.stringify(partial), /private fixture interruption/);

      const metadata = join(f.source, '.astack', '.astack-managed');
      const names = await readdir(metadata);
      const repeat = view(await initializeProject(request, f.deps), 'partial');

      assert.equal(
        repeat.assets.find((asset) => asset.kind === 'project-config')?.state,
        'pending',
      );
      assert.deepEqual(await readdir(metadata), names);
      assert.equal(f.fake.calls.length, 0);

      git(f.source, 'check-ignore', '-q', `.astack/${metadataPaths('config.json').pending}`);
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
            herdr: { target: { session: 'linked', socketPath: join(f.root, 'linked.sock') } },
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
  'packed init preview and neutral-directory failure create no state',
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
      const call = (args: string[], cwd = root, json = true) =>
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
            ...(json ? ['--json'] : []),
          ],
          {
            cwd,
            encoding: 'utf8',
            timeout: 60000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: root },
          },
        );
      const preview = call([source, '--dry-run']);

      assert.equal(preview.status, 0, preview.stderr);

      const previewView = view(
        initializationResultSchema.parse(JSON.parse(preview.stdout)),
        'previewed',
      );

      assert.ok(previewView.nextSteps?.some((step) => step.includes('astack init')));
      assert.equal(previewView.delegation, 'not_checked');

      await assert.rejects(access(state), { code: 'ENOENT' });
      await assert.rejects(access(userSkills), { code: 'ENOENT' });
      await assert.rejects(access(join(source, '.astack')), { code: 'ENOENT' });
      const neutral = call([]);

      assert.equal(neutral.status, 1);

      const failed = initializationResultSchema.parse(JSON.parse(neutral.stdout));

      assert.ok(failed.outcome === 'rejected' && failed.error.code === 'project_context_required');

      await assert.rejects(access(state), { code: 'ENOENT' });
      const initialized = call([source, '--id', 'packed-project', '--with-skills']);

      assert.equal(initialized.status, 1, initialized.stderr || initialized.stdout);

      const actual = view(
        initializationResultSchema.parse(JSON.parse(initialized.stdout)),
        'partial',
      );

      assert.equal(actual.provider.status, 'blocked');
      assert.ok(actual.nextSteps?.some((step) => step.includes('.astack/config.json')));
      assert.ok(actual.nextSteps?.some((step) => step.includes('Herdr')));
      assert.ok(actual.nextSteps?.some((step) => step.includes('Commit and push')));
      assert.ok(!actual.nextSteps?.some((step) => step.includes('Submit an implementation')));
      assert.ok(actual.diagnostics.some((item) => item.code.startsWith('herdr_')));

      for (const name of ['astack-orchestrator', 'astack-implementer', 'astack-reviewer']) {
        await access(join(source, '.agents', 'skills', name, 'SKILL.md'));
      }

      assert.equal(actual.target.projectId, 'packed-project');
      assert.equal(actual.delegation, 'not_ready');

      const human = call(['--project', 'packed-project', '--with-skills'], root, false);

      assert.equal(human.status, 1);
      assert.match(human.stdout, /Project skills: unchanged/);
      assert.match(human.stdout, /astack-implementer: current/);
      assert.match(human.stdout, /Commit and push/);
      assert.match(human.stdout, /herdr_[a-z_]+:/);

      const humanPreview = call(['--project', 'packed-project', '--dry-run'], root, false);

      assert.match(humanPreview.stdout, /Herdr workspace: not checked/);

      const readonly = call(['--project', 'packed-project', '--dry-run']);

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

      await assert.rejects(access(join(f.source, '.astack', 'config.json')), { code: 'ENOENT' });

      assert.equal(f.fake.calls.length, 0);
    });
  },
);

await test(
  'missing explicit provider target retains successful setup without contacting a provider',
  options,
  async () => {
    await fixture(async (f) => {
      const { defaultHerdrTarget: _defaultHerdrTarget, ...noDefault } = f.deps;
      const result = view(
        await initializeProject({ schemaVersion: 1, path: f.source, herdr: {} }, noDefault),
        'partial',
      );

      assert.equal(result.registration, 'created');
      assert.equal(result.provider.status, 'blocked');
      assert.ok(result.diagnostics.some((item) => item.code === 'herdr_target_required'));
      assert.equal(f.fake.calls.length, 0);

      await access(join(f.source, '.astack', 'config.json'));
    });
  },
);

await test(
  'real project configuration changes affect new jobs without changing accepted jobs',
  options,
  async () => {
    await fixture(async (f) => {
      const projectId = 'project-config-flow';
      view(
        await initializeProject(
          { schemaVersion: 1, path: f.source, assignProjectId: projectId },
          f.deps,
        ),
        'initialized',
      );
      const path = join(f.source, '.astack', 'config.json');
      const config: {
        schemaVersion: number;
        agents: {
          implementer: { provider: string; model: string | null; reasoning: string | null };
        };
      } = {
        schemaVersion: 1,
        agents: { implementer: { provider: 'fixture', model: 'first-model', reasoning: 'high' } },
      };
      await writeFile(path, JSON.stringify(config));
      let sequence = 0;
      const deps = {
        ...f.deps,
        queue: f.opened.service,
        now: () => 1000,
        nextId: (kind: 'job' | 'attempt' | 'effect' | 'claim') => `${kind}-${++sequence}`,
      };
      const request = {
        schemaVersion: 1,
        projectId,
        role: 'implementer',
        key: 'first',
        branch: 'refs/heads/main',
        commit: git(f.source, 'rev-parse', 'HEAD'),
        task: { text: 'fixture' },
      };
      const first = await submitServiceJob(request, deps);

      assert.ok(first.outcome === 'persisted', JSON.stringify(first));

      config.agents.implementer.model = null;
      await writeFile(path, JSON.stringify(config));
      const old = await checkConfigurationDispatch(
        { schemaVersion: 1, job: first.value.job },
        deps,
      );
      const next = await submitServiceJob({ ...request, key: 'second' }, deps);

      assert.ok(old.outcome === 'completed' && old.value.status === 'ready', JSON.stringify(old));
      assert.ok(next.outcome === 'rejected' && next.error.code === 'configuration_blocked');
    });
  },
);

await test('initialization reports agent readiness independently', options, async () => {
  await fixture(async (f) => {
    const request = { schemaVersion: 1, path: f.source };
    view(await initializeProject(request, f.deps), 'initialized');
    await writeFile(
      join(f.source, '.astack', 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        agents: {
          implementer: { provider: 'fixture', model: 'example', reasoning: 'high' },
          reviewer: { provider: 'fixture', model: null, reasoning: null },
        },
      }),
    );
    const result = view(await initializeProject(request, f.deps), 'initialized');

    assert.equal(result.delegation, 'ready');
    assert.equal(
      result.configuration.find((agent) => agent.role === 'implementer')?.readiness,
      'ready',
    );
    assert.equal(
      result.configuration.find((agent) => agent.role === 'reviewer')?.readiness,
      'not_ready',
    );

    const preview = view(
      await initializeProject({ ...request, preview: true }, f.deps),
      'previewed',
    );

    assert.equal(preview.delegation, 'not_checked');
    assert.equal(
      preview.configuration.find((agent) => agent.role === 'implementer')?.readiness,
      'not_checked',
    );
    assert.equal(
      preview.configuration.find((agent) => agent.role === 'reviewer')?.readiness,
      'not_ready',
    );
  });
});

await test(
  'project configuration is used immediately and changes are read without approval',
  options,
  async () => {
    await fixture(async (f) => {
      const projectId = 'config-project';
      view(
        await initializeProject(
          { schemaVersion: 1, path: f.source, assignProjectId: projectId },
          f.deps,
        ),
        'initialized',
      );
      const config = join(f.source, '.astack', 'config.json');
      const reader = createNodeConfigurationReader(f.opened.registry, f.opened.store);

      assert.ok(await reader.readPolicy(projectId));

      const projectConfig = {
        schemaVersion: 1,
        agents: { implementer: { provider: 'fixture', model: 'first-model', reasoning: 'high' } },
      };
      await writeFile(config, JSON.stringify(projectConfig));
      const ready = await resolveConfiguration(
        { schemaVersion: 1, projectId, role: 'implementer' },
        f.deps,
      );

      assert.ok(
        ready.outcome === 'completed' && ready.value.status === 'ready',
        JSON.stringify(ready),
      );

      const originalDigest = ready.value.snapshot?.policyDigest;
      projectConfig.agents.implementer.model = 'second-model';
      await writeFile(config, JSON.stringify(projectConfig));
      const changed = await resolveConfiguration(
        { schemaVersion: 1, projectId, role: 'implementer' },
        f.deps,
      );

      assert.ok(
        changed.outcome === 'completed' && changed.value.status === 'ready',
        JSON.stringify(changed),
      );
      assert.notEqual(changed.value.snapshot?.policyDigest, originalDigest);

      await assert.rejects(access(join(f.state, 'approvals')), { code: 'ENOENT' });
      await assert.rejects(access(join(f.state, 'config')), { code: 'ENOENT' });
    });
  },
);

await test(
  'initialization reuses an existing same-name Herdr workspace without checking its cwd',
  options,
  async () => {
    await fixture(async (f) => {
      assert.ok(f.deps.defaultHerdrTarget);

      const existing = f.fake.add(f.deps.defaultHerdrTarget, '/different-project', 'repository');
      const initialized = view(
        await initializeProject(
          { schemaVersion: 1, path: f.source, assignProjectId: 'reuse-project' },
          f.deps,
        ),
        'initialized',
      );
      const result = initialized.provider.result;

      assert.ok(result && 'record' in result);
      assert.equal(result.outcome, 'reused');
      assert.equal(result.record?.label, 'repository');
      assert.equal(result.record?.handle?.workspaceId, existing.workspaceId);
      assert.equal(f.fake.calls.filter((call) => call.operation === 'create').length, 0);
    });
  },
);
