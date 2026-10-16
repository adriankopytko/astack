import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  openSqliteState,
  registerProject,
  selectProjectContext,
  prepareWorktree,
  inspectWorktree,
  removeWorktree,
  reconcileWorktree,
  createWorktreeGit,
  createGitInspector,
  createNodeWorktreeFiles,
  nodeProcessRunner,
  nodeCheckoutIdentityReader,
  worktreeResultSchema,
  acceptStateJob,
  prepareStateAttempt,
  claimStateEffect,
  resolveStateEffect,
  recordStateResult,
  retainStateResource,
  releaseStateResource,
  type WorktreeDependencies,
  type WorktreeResult,
  type WorktreeRecord,
  type WorktreePrepareRequest,
} from '../src/index.js';

const gitPath = spawnSync('/usr/bin/which', ['git'], {
  env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
  encoding: 'utf8',
}).stdout.trim();
const options = { timeout: 90_000 };
const compiled = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const childFixture = fileURLToPath(new URL('./fixtures/worktree-child.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

function git(cwd: string, ...args: string[]) {
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

function record(result: WorktreeResult, outcome?: string): WorktreeRecord {
  worktreeResultSchema.parse(result);

  if (outcome) {
    assert.equal(result.outcome, outcome);
  }

  if (!('record' in result)) {
    assert.fail(JSON.stringify(result));
  }

  return result.record;
}

async function fixture(
  check: (context: {
    root: string;
    source: string;
    state: string;
    deps: WorktreeDependencies;
    input: WorktreePrepareRequest;
    opened: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astack worktrees ')));
  const source = join(root, 'source');
  const state = join(root, 'state');
  await mkdir(source);
  git(source, 'init', '--initial-branch=main');
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await writeFile(join(source, '.gitignore'), '.env\n.cache/\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'fixture');
  const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: state });

  if (opened.outcome !== 'opened') {
    assert.fail(opened.error.code);
  }

  let sequence = 0;
  const managedRoot = join(state, 'worktrees');
  const deps: WorktreeDependencies = {
    registry: opened.registry,
    store: opened.worktrees,
    git: createGitInspector({ executable: gitPath, runner: nodeProcessRunner, timeoutMs: 20_000 }),
    identity: nodeCheckoutIdentityReader,
    files: createNodeWorktreeFiles(managedRoot),
    managedRoot,
    effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
    now: () => 1000,
    nextId: (kind) => `${kind}-${++sequence}`,
  };
  const registration = await registerProject(
    { schemaVersion: 1, path: source },
    { ...deps, nextId: (kind) => `${kind}-fixture` },
  );

  if (registration.outcome !== 'persisted') {
    assert.fail(registration.error.code);
  }

  const input: WorktreePrepareRequest = {
    schemaVersion: 1,
    projectId: registration.value.project.id,
    key: 'task',
    branch: 'refs/heads/astack/task',
    baseCommit: git(source, 'rev-parse', 'HEAD'),
  };

  try {
    await check({ root, source, state, deps, input, opened });
  } finally {
    opened.store.close();
    await rm(root, { recursive: true, force: true });
  }
}

await test(
  'worktree lifecycle reuses verified ownership, registers its checkout and preserves committed branches',
  options,
  async () => {
    await fixture(async ({ source, deps, input }) => {
      let creates = 0;
      const effects = deps.effects;
      deps.effects = {
        ...effects,
        create: (intent, signal) => {
          creates++;

          return effects.create(intent, signal);
        },
      };
      const prepared = record(await prepareWorktree(input, deps), 'prepared');

      assert.equal(
        await readFile(join(prepared.intent.checkoutPath, 'tracked.txt'), 'utf8'),
        'original\n',
      );

      const context = await selectProjectContext(
        { schemaVersion: 1, projectId: input.projectId, checkoutId: prepared.intent.checkoutId },
        deps,
      );

      assert.equal(context.outcome, 'completed');
      assert.equal(
        record(await prepareWorktree(input, deps), 'reused').intent.id,
        prepared.intent.id,
      );
      assert.equal(creates, 1);

      await writeFile(join(prepared.intent.checkoutPath, 'tracked.txt'), 'implementation\n');
      git(prepared.intent.checkoutPath, 'commit', '-am', 'implementation');
      const head = git(prepared.intent.checkoutPath, 'rev-parse', 'HEAD');
      const removed = record(
        await removeWorktree({ schemaVersion: 1, id: prepared.intent.id }, deps),
        'removed',
      );

      assert.equal(removed.removalCommit, head);
      assert.equal(git(source, 'rev-parse', input.branch), head);

      await assert.rejects(lstat(prepared.intent.checkoutPath), { code: 'ENOENT' });

      assert.ok(await lstat(join(prepared.intent.containerPath, 'ownership.json')));

      record(await removeWorktree({ schemaVersion: 1, id: prepared.intent.id }, deps), 'removed');
    });
  },
);

await test(
  'tracked edits, untracked files and ignored secrets block removal without data loss',
  options,
  async () => {
    await fixture(async ({ deps, input }) => {
      const prepared = record(await prepareWorktree(input, deps), 'prepared');
      const request = { schemaVersion: 1, id: prepared.intent.id };
      const path = prepared.intent.checkoutPath;
      await writeFile(join(path, 'tracked.txt'), 'edited\n');
      const dirty = await removeWorktree(request, deps);

      assert.equal(dirty.outcome === 'blocked' && dirty.reason, 'dirty');
      assert.equal(await readFile(join(path, 'tracked.txt'), 'utf8'), 'edited\n');

      await writeFile(join(path, 'tracked.txt'), 'original\n');
      await writeFile(join(path, 'authored.txt'), 'untracked');

      assert.equal((await removeWorktree(request, deps)).outcome, 'blocked');
      assert.equal(await readFile(join(path, 'authored.txt'), 'utf8'), 'untracked');

      await rm(join(path, 'authored.txt'));
      await writeFile(join(path, '.env'), 'private-secret');
      const ignored = await removeWorktree(request, deps);

      assert.equal(ignored.outcome === 'blocked' && ignored.reason, 'ignored_files');
      assert.equal(await readFile(join(path, '.env'), 'utf8'), 'private-secret');
      assert.doesNotMatch(JSON.stringify(ignored), /private-secret/);
    });
  },
);

await test(
  'unowned markers, changed branches and locked worktrees are preserved',
  options,
  async () => {
    await fixture(async ({ source, deps, input }) => {
      const prepared = record(await prepareWorktree(input, deps), 'prepared');
      const request = { schemaVersion: 1, id: prepared.intent.id };
      git(source, 'worktree', 'lock', prepared.intent.checkoutPath);
      const locked = await removeWorktree(request, deps);

      assert.equal(locked.outcome === 'blocked' && locked.reason, 'locked');

      git(source, 'worktree', 'unlock', prepared.intent.checkoutPath);
      git(prepared.intent.checkoutPath, 'switch', '-c', 'user-branch');
      const changed = await removeWorktree(request, deps);

      assert.equal(changed.outcome === 'blocked' && changed.reason, 'branch_changed');

      git(prepared.intent.checkoutPath, 'switch', input.branch.slice('refs/heads/'.length));
      await writeFile(join(prepared.intent.containerPath, 'ownership.json'), 'authored-marker');
      const unowned = await removeWorktree(request, deps);

      assert.equal(unowned.outcome === 'blocked' && unowned.reason, 'unowned');
      assert.equal(
        await readFile(join(prepared.intent.containerPath, 'ownership.json'), 'utf8'),
        'authored-marker',
      );
      assert.equal(
        (await inspectWorktree({ schemaVersion: 1, id: 'unowned' }, deps)).outcome,
        'rejected',
      );
      assert.ok(await lstat(prepared.intent.checkoutPath));
    });
  },
);

await test(
  'concurrent prepare submits one Git writer and cannot retarget a stable owner key',
  options,
  async () => {
    await fixture(async ({ deps, input }) => {
      let creates = 0;
      const effects = deps.effects;
      deps.effects = {
        ...effects,
        create: (intent, signal) => {
          creates++;

          return effects.create(intent, signal);
        },
      };
      const results = await Promise.all([
        prepareWorktree(input, deps),
        prepareWorktree(input, deps),
      ]);

      assert.equal(results.filter((result) => result.outcome === 'prepared').length, 1);
      assert.equal(creates, 1);
      assert.ok(
        results.every((result) => ['prepared', 'pending', 'rejected'].includes(result.outcome)),
      );

      const conflict = await prepareWorktree({ ...input, branch: 'refs/heads/other-task' }, deps);

      assert.equal(conflict.outcome === 'rejected' && conflict.error.code, 'worktree_conflict');
    });
  },
);

await test(
  'creation interrupted after Git completion stays pending until explicit quiescent reconciliation',
  options,
  async () => {
    await fixture(async ({ deps, input }) => {
      const effects = deps.effects;
      let creates = 0;
      deps.effects = {
        ...effects,
        async create(intent, signal) {
          creates++;
          await effects.create(intent, signal);

          throw new Error('private-interruption');
        },
      };
      const interrupted = await prepareWorktree(input, deps);
      const saved = record(interrupted, 'pending');

      assert.doesNotMatch(JSON.stringify(interrupted), /private-interruption/);

      record(await prepareWorktree(input, deps), 'pending');

      assert.equal(creates, 1);
      assert.equal(
        (
          await reconcileWorktree(
            { schemaVersion: 1, id: saved.intent.id, operationId: saved.operationId },
            deps,
          )
        ).outcome,
        'rejected',
      );
      assert.equal(
        (
          await reconcileWorktree(
            { schemaVersion: 1, id: saved.intent.id, operationId: 'stale', writerStopped: true },
            deps,
          )
        ).outcome,
        'rejected',
      );

      const recovered = record(
        await reconcileWorktree(
          {
            schemaVersion: 1,
            id: saved.intent.id,
            operationId: saved.operationId,
            writerStopped: true,
          },
          deps,
        ),
        'reconciled',
      );

      assert.equal(recovered.phase, 'ready');
      assert.equal(recovered.reconciliation?.source, 'host-attestation');

      record(await prepareWorktree(input, deps), 'reused');
    });
  },
);

await test(
  'hard exits during creation and removal retain recoverable records and task branches',
  options,
  async () => {
    await fixture(async ({ deps, input, state, root, source }) => {
      const create = spawnSync(
        process.execPath,
        [childFixture, compiled, state, gitPath, 'create', JSON.stringify(input)],
        { cwd: root, env: {}, encoding: 'utf8', timeout: 15_000 },
      );

      assert.equal(create.status, 71, create.stderr);

      const found = deps.store.find(input.projectId, input.key);

      if (found.outcome !== 'completed' || !found.value) {
        assert.fail('Missing creation intent');
      }

      const prepared = record(
        await reconcileWorktree(
          {
            schemaVersion: 1,
            id: found.value.intent.id,
            operationId: found.value.operationId,
            writerStopped: true,
          },
          deps,
        ),
        'reconciled',
      );
      const remove = spawnSync(
        process.execPath,
        [
          childFixture,
          compiled,
          state,
          gitPath,
          'remove',
          JSON.stringify({ schemaVersion: 1, id: prepared.intent.id }),
        ],
        { cwd: root, env: {}, encoding: 'utf8', timeout: 15_000 },
      );

      assert.equal(remove.status, 71, remove.stderr);

      const observed = record(
        await inspectWorktree({ schemaVersion: 1, id: prepared.intent.id }, deps),
        'inspected',
      );

      assert.equal(observed.phase, 'removing');

      record(await removeWorktree({ schemaVersion: 1, id: observed.intent.id }, deps), 'pending');
      const recovered = record(
        await reconcileWorktree(
          {
            schemaVersion: 1,
            id: observed.intent.id,
            operationId: observed.operationId,
            writerStopped: true,
          },
          deps,
        ),
        'reconciled',
      );

      assert.equal(recovered.phase, 'removed');
      assert.equal(git(source, 'rev-parse', input.branch), input.baseCommit);
    });
  },
);

await test(
  'absence can be reconciled without retrying creation; unmarked partial containers are never adopted',
  options,
  async () => {
    await fixture(async ({ deps, input }) => {
      const files = deps.files;
      deps.files = {
        ...files,
        prepare: async () => {
          throw new Error('interrupted-before-files');
        },
      };
      const pending = record(await prepareWorktree(input, deps), 'pending');
      const abandoned = record(
        await reconcileWorktree(
          {
            schemaVersion: 1,
            id: pending.intent.id,
            operationId: pending.operationId,
            writerStopped: true,
          },
          deps,
        ),
        'reconciled',
      );

      assert.equal(abandoned.phase, 'abandoned');

      record(await prepareWorktree(input, deps), 'blocked');
      deps.files = {
        ...files,
        async prepare(intent) {
          await mkdir(intent.managedRoot, { mode: 0o700 });
          await mkdir(intent.containerPath, { mode: 0o700 });
          await writeFile(join(intent.containerPath, 'authored'), 'preserve');

          throw new Error('interrupted-before-marker');
        },
      };
      const partial = record(
        await prepareWorktree({ ...input, key: 'partial', branch: 'refs/heads/partial' }, deps),
        'pending',
      );
      const preserved = await reconcileWorktree(
        {
          schemaVersion: 1,
          id: partial.intent.id,
          operationId: partial.operationId,
          writerStopped: true,
        },
        deps,
      );

      assert.equal(preserved.outcome === 'blocked' && preserved.reason, 'unowned');
      assert.equal(
        await readFile(join(partial.intent.containerPath, 'authored'), 'utf8'),
        'preserve',
      );
    });
  },
);

await test(
  'branch-only partial creation is retained without adopting or deleting that branch',
  options,
  async () => {
    await fixture(async ({ deps, input, source }) => {
      deps.effects = {
        ...deps.effects,
        async create(intent) {
          git(source, 'branch', intent.branch.slice('refs/heads/'.length), intent.baseCommit);

          throw new Error('interrupted-after-branch');
        },
      };
      const pending = record(await prepareWorktree(input, deps), 'pending');
      const result = await reconcileWorktree(
        {
          schemaVersion: 1,
          id: pending.intent.id,
          operationId: pending.operationId,
          writerStopped: true,
        },
        deps,
      );

      assert.equal(result.outcome === 'blocked' && result.reason, 'partial');
      assert.equal(git(source, 'rev-parse', input.branch), input.baseCommit);
    });
  },
);

await test(
  'attempt-bound cleanup requires a terminal result and release of other retained resources',
  options,
  async () => {
    await fixture(async ({ deps, input, opened }) => {
      const context = await selectProjectContext(
        { schemaVersion: 1, projectId: input.projectId },
        deps,
      );

      if (context.outcome !== 'completed' || !context.value.project || !context.value.checkout) {
        assert.fail('Missing source');
      }

      assert.equal(
        acceptStateJob(
          {
            schemaVersion: 1,
            job: {
              id: 'job',
              projectId: input.projectId,
              repositoryId: context.value.project.repository.id,
              checkoutId: context.value.checkout.checkout.id,
              requester: 'host',
              operation: 'implementation',
              idempotencyKey: 'task',
              createdAt: 1000,
              intent: {},
            },
          },
          opened.store,
        ).outcome,
        'persisted',
      );
      assert.equal(
        prepareStateAttempt(
          {
            schemaVersion: 1,
            attempt: {
              id: 'attempt',
              jobId: 'job',
              number: 1,
              branch: input.branch,
              commit: input.baseCommit,
              createdAt: 1000,
            },
            effects: [
              {
                id: 'launch',
                attemptId: 'attempt',
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

      const prepared = record(
        await prepareWorktree({ ...input, runId: 'attempt' }, deps),
        'prepared',
      );
      const request = { schemaVersion: 1, id: prepared.intent.id };
      const active = await removeWorktree(request, deps);

      assert.equal(active.outcome === 'blocked' && active.reason, 'resource_in_use');
      assert.equal(
        claimStateEffect(
          { schemaVersion: 1, effectId: 'launch', owner: 'host', token: 'claim' },
          opened.store,
        ).outcome,
        'persisted',
      );
      assert.equal(
        resolveStateEffect(
          {
            schemaVersion: 1,
            effectId: 'launch',
            owner: 'host',
            token: 'claim',
            state: 'confirmed',
            evidence: {},
          },
          opened.store,
        ).outcome,
        'persisted',
      );
      assert.equal(
        recordStateResult(
          {
            schemaVersion: 1,
            result: {
              id: 'result',
              attemptId: 'attempt',
              outcome: 'completed',
              createdAt: 2000,
              evidence: {},
            },
          },
          opened.store,
        ).outcome,
        'persisted',
      );
      assert.equal(
        retainStateResource(
          {
            schemaVersion: 1,
            resource: {
              id: 'runtime',
              attemptId: 'attempt',
              kind: 'runtime',
              key: 'worker',
              createdAt: 1000,
              handle: {},
            },
          },
          opened.store,
        ).outcome,
        'persisted',
      );

      const retained = await removeWorktree(request, deps);

      assert.equal(retained.outcome === 'blocked' && retained.reason, 'resource_in_use');
      assert.equal(
        releaseStateResource(
          {
            schemaVersion: 1,
            resourceId: 'runtime',
            attemptId: 'attempt',
            evidence: { verifiedStopped: true },
          },
          opened.store,
        ).outcome,
        'persisted',
      );

      record(await removeWorktree(request, deps), 'removed');
    });
  },
);

await test(
  'CLI prepares and inspects an explicit project from a neutral cwd with structured outcomes',
  options,
  async () => {
    await fixture(async ({ state, root, input }) => {
      const command = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [
            cli,
            '--state-directory',
            state,
            '--git-executable',
            gitPath,
            'worktree',
            ...args,
            '--json',
          ],
          { cwd: root, env: {}, encoding: 'utf8', timeout: 20_000 },
        );
      const prepared = command(
        'prepare',
        '--project',
        input.projectId,
        '--key',
        input.key,
        '--branch',
        input.branch,
        '--base',
        input.baseCommit,
      );

      assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);

      const owned = record(
        worktreeResultSchema.parse(JSON.parse(prepared.stdout) as unknown),
        'prepared',
      );
      const inspected = command('inspect', owned.intent.id);

      assert.equal(inspected.status, 0, inspected.stderr);

      record(worktreeResultSchema.parse(JSON.parse(inspected.stdout) as unknown), 'inspected');
    });
  },
);

await test(
  'invalid selectors, unsupported filters, and cancellation start no worktree writer',
  options,
  async () => {
    await fixture(async ({ deps, input, source }) => {
      let creates = 0;
      const effects = deps.effects;
      deps.effects = {
        ...effects,
        create: (intent, signal) => {
          creates++;

          return effects.create(intent, signal);
        },
      };

      assert.equal(
        (await prepareWorktree({ ...input, baseCommit: 'main' }, deps)).outcome,
        'rejected',
      );
      assert.equal(
        (await prepareWorktree({ ...input, branch: 'refs/heads/a..b' }, deps)).outcome,
        'rejected',
      );

      const controller = new AbortController();
      controller.abort();

      assert.equal((await prepareWorktree(input, deps, controller.signal)).outcome, 'rejected');

      git(source, 'config', 'filter.authored.smudge', 'must-not-run');
      const unsupported = await prepareWorktree(input, deps);

      assert.equal(
        unsupported.outcome === 'rejected' && unsupported.error.code,
        'worktree_configuration_unsupported',
      );
      assert.equal(creates, 0);

      const stored = deps.store.find(input.projectId, input.key);

      assert.equal(stored.outcome === 'completed' && stored.value, null);
    });
  },
);

await test(
  'a replacement repository at the owned path is preserved as an identity mismatch',
  options,
  async () => {
    await fixture(async ({ deps, input }) => {
      const prepared = record(await prepareWorktree(input, deps), 'prepared');
      const original = prepared.intent.checkoutPath;
      const { rename } = await import('node:fs/promises');
      await rename(original, join(prepared.intent.containerPath, 'preserved-original'));
      await mkdir(original);
      git(original, 'init', '--initial-branch=independent');
      await writeFile(join(original, 'authored'), 'preserve replacement');
      const result = await removeWorktree({ schemaVersion: 1, id: prepared.intent.id }, deps);

      assert.equal(result.outcome === 'blocked' && result.reason, 'identity_changed');
      assert.equal(await readFile(join(original, 'authored'), 'utf8'), 'preserve replacement');
    });
  },
);

await test(
  'a managed source cannot be removed while a dependent worktree still uses it',
  options,
  async () => {
    await fixture(async ({ deps, input }) => {
      const parent = record(await prepareWorktree(input, deps), 'prepared');
      const child = record(
        await prepareWorktree(
          {
            ...input,
            checkoutId: parent.intent.checkoutId,
            key: 'dependent',
            branch: 'refs/heads/dependent',
          },
          deps,
        ),
        'prepared',
      );
      const retained = await removeWorktree({ schemaVersion: 1, id: parent.intent.id }, deps);

      assert.equal(retained.outcome === 'blocked' && retained.reason, 'resource_in_use');

      record(await removeWorktree({ schemaVersion: 1, id: child.intent.id }, deps), 'removed');
      record(await removeWorktree({ schemaVersion: 1, id: parent.intent.id }, deps), 'removed');
    });
  },
);
