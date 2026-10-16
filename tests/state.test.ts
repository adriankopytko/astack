import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acceptStateJob,
  claimStateEffect,
  inspectStateRecord,
  openSqliteState,
  prepareStateAttempt,
  recordStateResult,
  releaseStateResource,
  resolveProjectContext,
  resolveStateEffect,
  retainStateResource,
  saveStateProject,
  stateJobSchema,
  createStateWriteResultSchema,
  type StateStore,
  type StateWriteResult,
  type StateRecord,
} from '../src/index.js';
import { openStateDatabase } from '../src/adapters/state/database.js';
import { stateMigrations } from '../src/adapters/state/migrations.js';

const options = { timeout: 15_000 };
const sha = 'a'.repeat(40);

async function temporary(check: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'astack state ')));

  try {
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function open(directory: string, now = () => 1000): Promise<StateStore> {
  const result = await openSqliteState(
    { schemaVersion: 1, stateDirectory: directory, busyTimeoutMs: 25 },
    { now },
  );

  if (result.outcome !== 'opened') {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }

  return result.store;
}

function persisted<T>(result: StateWriteResult<T>): T {
  if (result.outcome !== 'persisted') {
    assert.fail(`${result.outcome}: ${result.error.code}`);
  }

  return result.value;
}

function rejectedCode(result: { outcome: string; error?: { code: string } }): string | undefined {
  assert.equal(result.outcome, 'rejected');

  return result.error?.code;
}

function identity(directory: string, suffix = '') {
  return {
    schemaVersion: 1,
    repository: {
      id: `repository${suffix}`,
      commonDirectory: join(directory, `repo${suffix}/.git`),
      objectFormat: 'sha1',
    },
    project: { id: `project${suffix}`, primaryCheckoutId: `checkout${suffix}` },
    checkout: {
      id: `checkout${suffix}`,
      projectId: `project${suffix}`,
      repositoryId: `repository${suffix}`,
      rootPath: join(directory, `repo${suffix}`),
      gitCommonDirectory: join(directory, `repo${suffix}/.git`),
    },
  };
}

function job(suffix = '') {
  return {
    id: `job${suffix}`,
    projectId: `project${suffix}`,
    repositoryId: `repository${suffix}`,
    checkoutId: `checkout${suffix}`,
    requester: 'orchestrator',
    operation: 'implementation',
    idempotencyKey: 'selected-task',
    createdAt: 1000,
    intent: { task: 'Implement the selected change', policyRevision: 'policy-1' },
  };
}

function attempt(suffix = '', number = 1) {
  return {
    schemaVersion: 1,
    attempt: {
      id: `attempt${suffix}`,
      jobId: `job${suffix}`,
      number,
      branch: 'refs/heads/worker',
      commit: sha,
      createdAt: 1000,
    },
    effects: [
      {
        id: `launch${suffix}`,
        attemptId: `attempt${suffix}`,
        kind: 'launch',
        key: 'worker',
        createdAt: 1000,
        payload: { runtime: 'fixture', role: 'implementer' },
      },
    ],
  };
}

function setup(store: StateStore, directory: string, suffix = '') {
  persisted(saveStateProject(identity(directory, suffix), store));
  persisted(acceptStateJob({ schemaVersion: 1, job: job(suffix) }, store));
  persisted(prepareStateAttempt(attempt(suffix), store));
}

function inspect(store: StateStore, entity: string, id: string): StateRecord | null {
  const result = inspectStateRecord({ schemaVersion: 1, entity, id }, store);

  if (result.outcome !== 'completed') {
    assert.fail(result.error.code);
  }

  return result.value;
}

function claim(store: StateStore, suffix = '') {
  return persisted(
    claimStateEffect(
      {
        schemaVersion: 1,
        effectId: `launch${suffix}`,
        owner: 'coordinator',
        token: `claim${suffix}`,
        leaseMs: 100,
      },
      store,
    ),
  );
}

function resolveEffect(store: StateStore, suffix = '') {
  claim(store, suffix);

  return persisted(
    resolveStateEffect(
      {
        schemaVersion: 1,
        effectId: `launch${suffix}`,
        owner: 'coordinator',
        token: `claim${suffix}`,
        state: 'confirmed',
        evidence: { providerHandle: `worker${suffix}` },
      },
      store,
    ),
  );
}

await test(
  'state requests validate versions, selectors, bounded JSON and cancellation before storage',
  options,
  async () => {
    await temporary(async (directory) => {
      const store = await open(join(directory, 'state'));

      try {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        for (const intent of [
          { task: 'x'.repeat(20_000) },
          cyclic,
          { number: Infinity },
          { callback: () => 1 },
          { object: new Date() },
        ]) {
          assert.equal(
            rejectedCode(acceptStateJob({ schemaVersion: 1, job: { ...job(), intent } }, store)),
            'invalid_request',
          );
        }

        assert.equal(
          rejectedCode(acceptStateJob({ schemaVersion: 2, job: job() }, store)),
          'unsupported_contract_version',
        );
        assert.equal(
          rejectedCode(
            inspectStateRecord({ schemaVersion: 1, entity: 'invented', id: 'job' }, store),
          ),
          'invalid_request',
        );

        const controller = new AbortController();
        controller.abort();

        assert.equal(
          rejectedCode(saveStateProject(identity(directory), store, controller.signal)),
          'cancelled',
        );
        assert.equal(inspect(store, 'job', 'job'), null);
        assert.equal(
          rejectedCode(await openSqliteState({ schemaVersion: 1, stateDirectory: 'relative' })),
          'invalid_request',
        );
        assert.equal(
          rejectedCode(
            await openSqliteState({
              schemaVersion: 1,
              stateDirectory: directory,
              busyTimeoutMs: 1001,
            }),
          ),
          'invalid_request',
        );
      } finally {
        store.close();
      }
    });
  },
);

await test(
  'numbered migrations and stored identities survive close/reopen and feed context resolution',
  options,
  async () => {
    await temporary(async (directory) => {
      const path = join(directory, 'private state');
      const store = await open(path);
      const saved = saveStateProject(identity(directory), store);

      assert.equal(saved.outcome, 'persisted');
      assert.equal(saveStateProject(identity(directory), store).outcome, 'persisted');

      persisted(acceptStateJob({ schemaVersion: 1, job: job() }, store));
      store.close();
      const reopened = await open(path);

      try {
        const context = await resolveProjectContext(
          { schemaVersion: 1, projectId: 'project' },
          reopened,
        );

        assert.equal(context.outcome, 'completed');
        assert.equal(inspect(reopened, 'job', 'job')?.entity, 'job');
        assert.equal((await lstat(path)).mode & 0o077, 0);
        assert.equal((await lstat(join(path, 'state.sqlite'))).mode & 0o077, 0);

        const raw = new DatabaseSync(join(path, 'state.sqlite'));

        try {
          assert.equal(
            raw.prepare('PRAGMA user_version').get()?.user_version,
            stateMigrations.length,
          );
          assert.equal(
            raw.prepare('SELECT COUNT(*) AS count FROM state_migrations').get()?.count,
            stateMigrations.length,
          );
          assert.equal(raw.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
        } finally {
          raw.close();
        }
      } finally {
        reopened.close();
      }

      const configured = openStateDatabase(join(path, 'state.sqlite'), 25);

      try {
        assert.equal(configured.statement('PRAGMA foreign_keys').get()?.foreign_keys, 1);
        assert.equal(configured.statement('PRAGMA synchronous').get()?.synchronous, 2);
        assert.equal(configured.statement('PRAGMA busy_timeout').get()?.timeout, 25);
        assert.equal(configured.statement('PRAGMA trusted_schema').get()?.trusted_schema, 0);
        assert.equal(configured.statement('PRAGMA locking_mode').get()?.locking_mode, 'normal');
      } finally {
        configured.close();
      }
    });
  },
);

await test(
  'idempotent job acceptance returns the original identity and rejects changed intent',
  options,
  async () => {
    await temporary(async (directory) => {
      const path = join(directory, 'state');
      const first = await open(path);
      const second = await open(path);

      try {
        persisted(saveStateProject(identity(directory), first));
        const original = persisted(acceptStateJob({ schemaVersion: 1, job: job() }, first));
        const duplicate = acceptStateJob(
          {
            schemaVersion: 1,
            job: {
              ...job(),
              id: 'replacement-id',
              createdAt: 2000,
              intent: { policyRevision: 'policy-1', task: 'Implement the selected change' },
            },
          },
          second,
        );

        assert.deepEqual(persisted(duplicate), original);
        assert.equal(duplicate.outcome === 'persisted' && duplicate.disposition, 'existing');
        assert.equal(inspect(first, 'job', 'replacement-id'), null);
        assert.equal(
          rejectedCode(
            acceptStateJob(
              { schemaVersion: 1, job: { ...job(), intent: { task: 'different' } } },
              second,
            ),
          ),
          'state_conflict',
        );
        assert.equal(
          rejectedCode(
            acceptStateJob(
              { schemaVersion: 1, job: { ...job(), id: 'different', checkoutId: 'missing' } },
              second,
            ),
          ),
          'state_conflict',
        );
        assert.equal(
          createStateWriteResultSchema(stateJobSchema).safeParse(duplicate).success,
          true,
        );
      } finally {
        first.close();
        second.close();
      }
    });
  },
);

await test(
  'attempt and effect preparation is atomic and permits only one unresolved attempt',
  options,
  async () => {
    await temporary(async (directory) => {
      const store = await open(join(directory, 'state'));

      try {
        persisted(saveStateProject(identity(directory), store));
        persisted(acceptStateJob({ schemaVersion: 1, job: job() }, store));
        const request = attempt();
        const effect = request.effects[0];

        assert.ok(effect);
        assert.equal(
          rejectedCode(
            prepareStateAttempt(
              { ...request, effects: [effect, { ...effect, id: 'duplicate-key' }] },
              store,
            ),
          ),
          'state_conflict',
        );
        assert.equal(inspect(store, 'attempt', 'attempt'), null);
        assert.equal(inspect(store, 'effect', 'launch'), null);

        persisted(prepareStateAttempt(request, store));
        const repeated = prepareStateAttempt(request, store);

        assert.equal(repeated.outcome === 'persisted' && repeated.disposition, 'existing');
        assert.equal(
          rejectedCode(
            prepareStateAttempt(
              {
                ...request,
                attempt: { ...request.attempt, id: 'attempt-2', number: 2 },
                effects: [{ ...effect, id: 'launch-2', attemptId: 'attempt-2' }],
              },
              store,
            ),
          ),
          'state_reconciliation_required',
        );
        assert.equal(
          rejectedCode(
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
              store,
            ),
          ),
          'state_reconciliation_required',
        );
      } finally {
        store.close();
      }
    });
  },
);

await test(
  'short claims coordinate connections and expiration never authorizes a second launch',
  options,
  async () => {
    await temporary(async (directory) => {
      let time = 1000;
      const path = join(directory, 'state');
      const first = await open(path, () => time);
      const second = await open(path, () => time);

      try {
        setup(first, directory);
        const claimed = claim(first);

        assert.equal(claimed.claim?.expiresAt, 1100);
        assert.equal(
          rejectedCode(
            claimStateEffect(
              { schemaVersion: 1, effectId: 'launch', owner: 'other', token: 'other-token' },
              second,
            ),
          ),
          'state_conflict',
        );
        assert.deepEqual(claim(second), claimed);

        time = 1101;

        assert.equal(
          rejectedCode(
            claimStateEffect(
              { schemaVersion: 1, effectId: 'launch', owner: 'other', token: 'other-token' },
              second,
            ),
          ),
          'state_reconciliation_required',
        );

        const resolution = {
          schemaVersion: 1,
          effectId: 'launch',
          owner: 'coordinator',
          token: 'claim',
          state: 'unknown',
          evidence: { observation: 'launch handle not confirmed' },
        };
        persisted(resolveStateEffect(resolution, first));
        first.close();
        const reopened = await open(path, () => time);

        try {
          const record = inspect(reopened, 'effect', 'launch');

          assert.equal(record?.entity === 'effect' && record.record.state, 'unknown');
          assert.equal(
            rejectedCode(
              claimStateEffect(
                { schemaVersion: 1, effectId: 'launch', owner: 'other', token: 'other-token' },
                reopened,
              ),
            ),
            'state_reconciliation_required',
          );
          assert.equal(
            rejectedCode(resolveStateEffect({ ...resolution, owner: 'other' }, reopened)),
            'state_conflict',
          );

          persisted(
            resolveStateEffect(
              {
                ...resolution,
                state: 'confirmed',
                evidence: { providerHandle: 'verified-worker' },
              },
              reopened,
            ),
          );
        } finally {
          reopened.close();
        }
      } finally {
        first.close();
        second.close();
      }
    });
  },
);

await test(
  'terminal result resolution is atomic and retains independent owned resources',
  options,
  async () => {
    await temporary(async (directory) => {
      const store = await open(join(directory, 'state'));

      try {
        setup(store, directory);
        persisted(
          retainStateResource(
            {
              schemaVersion: 1,
              resource: {
                id: 'worktree',
                attemptId: 'attempt',
                kind: 'worktree',
                key: 'checkout-worker',
                createdAt: 1000,
                handle: { checkoutId: 'checkout' },
              },
            },
            store,
          ),
        );
        resolveEffect(store);
        const result = {
          schemaVersion: 1,
          result: {
            id: 'result',
            attemptId: 'attempt',
            outcome: 'completed',
            createdAt: 2000,
            evidence: { commit: sha, artifactId: 'report' },
          },
        };
        persisted(recordStateResult(result, store));
        const repeated = recordStateResult(result, store);

        assert.equal(repeated.outcome === 'persisted' && repeated.disposition, 'existing');
        assert.equal(
          rejectedCode(
            recordStateResult(
              { ...result, result: { ...result.result, outcome: 'failed' } },
              store,
            ),
          ),
          'state_conflict',
        );

        const resource = inspect(store, 'resource', 'worktree');
        const resolved = inspect(store, 'attempt', 'attempt');

        assert.equal(resource?.entity === 'resource' && resource.record.releasedAt, null);
        assert.equal(resolved?.entity === 'attempt' && resolved.resolvedAt, 2000);

        const next = attempt();
        const effect = next.effects[0];

        assert.ok(effect);

        persisted(
          prepareStateAttempt(
            {
              ...next,
              attempt: { ...next.attempt, id: 'attempt-2', number: 2 },
              effects: [{ ...effect, id: 'launch-2', attemptId: 'attempt-2' }],
            },
            store,
          ),
        );
      } finally {
        store.close();
      }
    });
  },
);

await test(
  'resource uniqueness spans projects and release requires the recorded attempt',
  options,
  async () => {
    await temporary(async (directory) => {
      const store = await open(join(directory, 'state'));

      try {
        setup(store, directory);
        setup(store, directory, '-other');
        const resource = {
          id: 'port',
          attemptId: 'attempt',
          kind: 'port',
          key: '4000',
          createdAt: 1000,
          handle: { port: 4000 },
        };
        persisted(retainStateResource({ schemaVersion: 1, resource }, store));

        assert.equal(
          rejectedCode(
            retainStateResource(
              {
                schemaVersion: 1,
                resource: { ...resource, id: 'other-port', attemptId: 'attempt-other' },
              },
              store,
            ),
          ),
          'state_conflict',
        );
        assert.equal(
          rejectedCode(
            releaseStateResource(
              { schemaVersion: 1, resourceId: 'port', attemptId: 'attempt-other', evidence: {} },
              store,
            ),
          ),
          'state_conflict',
        );

        const release = {
          schemaVersion: 1,
          resourceId: 'port',
          attemptId: 'attempt',
          evidence: { verifiedStopped: true },
        };
        persisted(releaseStateResource(release, store));
        persisted(releaseStateResource(release, store));
        persisted(
          retainStateResource(
            {
              schemaVersion: 1,
              resource: { ...resource, id: 'other-port', attemptId: 'attempt-other' },
            },
            store,
          ),
        );
      } finally {
        store.close();
      }
    });
  },
);

await test(
  'foreign keys and scoped identity conflicts cannot leave partial project registration',
  options,
  async () => {
    await temporary(async (directory) => {
      const store = await open(join(directory, 'state'));

      try {
        persisted(saveStateProject(identity(directory), store));
        const other = identity(directory, '-other');
        const collision = {
          ...other,
          checkout: { ...other.checkout, rootPath: identity(directory).checkout.rootPath },
        };

        assert.equal(rejectedCode(saveStateProject(collision, store)), 'state_conflict');
        assert.equal(
          await store.readProject(other.project.id as Parameters<StateStore['readProject']>[0]),
          null,
        );
        assert.equal(
          rejectedCode(acceptStateJob({ schemaVersion: 1, job: job('-missing') }, store)),
          'state_conflict',
        );

        persisted(saveStateProject(other, store));
      } finally {
        store.close();
      }
    });
  },
);

await test(
  'lock contention is bounded and explicit; no writes are retried implicitly',
  options,
  async () => {
    await temporary(async (directory) => {
      const path = join(directory, 'state');
      const store = await open(path);
      const raw = new DatabaseSync(join(path, 'state.sqlite'));
      raw.exec('BEGIN IMMEDIATE');

      try {
        const before = performance.now();
        const result = saveStateProject(identity(directory), store);

        assert.equal(rejectedCode(result), 'state_busy');
        assert.ok(performance.now() - before < 1500);
        assert.equal(
          rejectedCode(
            await openSqliteState({ schemaVersion: 1, stateDirectory: path, busyTimeoutMs: 25 }),
          ),
          'state_busy',
        );
      } finally {
        raw.exec('ROLLBACK');
        raw.close();
      }

      try {
        assert.equal(
          await store.readProject('project' as Parameters<StateStore['readProject']>[0]),
          null,
        );

        persisted(saveStateProject(identity(directory), store));
      } finally {
        store.close();
      }
    });
  },
);

await test(
  'an interrupted transaction rolls back on process exit and retained intent reopens',
  options,
  async () => {
    await temporary(async (directory) => {
      const path = join(directory, 'state');
      const store = await open(path);
      setup(store, directory);
      store.close();
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE jobs SET data=json_set(data, '$.intent.task', 'uncommitted') WHERE id=?").run('job');
      db.exec('PRAGMA user_version=99');
      process.exit(71);
    `,
          join(path, 'state.sqlite'),
        ],
        { cwd: directory, env: {}, encoding: 'utf8', timeout: 5000 },
      );

      assert.equal(child.status, 71, child.stderr);

      const reopened = await open(path);

      try {
        const record = inspect(reopened, 'job', 'job');

        assert.equal(
          record?.entity === 'job' && record.record.intent.task,
          'Implement the selected change',
        );
        assert.equal(inspect(reopened, 'effect', 'launch')?.entity, 'effect');
      } finally {
        reopened.close();
      }
    });
  },
);

await test(
  'unknown, unsafe and repository-local directories are preserved and refused',
  options,
  async () => {
    await temporary(async (directory) => {
      const unknown = join(directory, 'unknown');
      await mkdir(unknown, { mode: 0o700 });
      await writeFile(join(unknown, 'authored'), 'private authored content');

      assert.equal(
        rejectedCode(await openSqliteState({ schemaVersion: 1, stateDirectory: unknown })),
        'state_directory_unsafe',
      );
      assert.equal(await readFile(join(unknown, 'authored'), 'utf8'), 'private authored content');

      const source = join(directory, 'source');
      await mkdir(join(source, '.git'), { recursive: true });

      assert.equal(
        rejectedCode(
          await openSqliteState({ schemaVersion: 1, stateDirectory: join(source, 'state') }),
        ),
        'state_directory_unsafe',
      );

      await assert.rejects(lstat(join(source, 'state')), { code: 'ENOENT' });
      const broad = join(directory, 'broad');
      await mkdir(broad, { mode: 0o700 });
      await chmod(broad, 0o755);

      assert.equal(
        rejectedCode(await openSqliteState({ schemaVersion: 1, stateDirectory: broad })),
        'state_directory_unsafe',
      );

      const path = join(directory, 'state');
      const store = await open(path);
      store.close();
      const target = join(directory, 'outside');
      await writeFile(target, 'preserve');
      await symlink(target, join(path, 'state.sqlite-wal'));

      assert.equal(
        rejectedCode(await openSqliteState({ schemaVersion: 1, stateDirectory: path })),
        'state_directory_unsafe',
      );
      assert.equal(await readFile(target, 'utf8'), 'preserve');
    });
  },
);

await test(
  'unsupported migration history and malformed stored records fail without raw diagnostics',
  options,
  async () => {
    await temporary(async (directory) => {
      const path = join(directory, 'state');
      const store = await open(path);
      setup(store, directory);
      store.close();
      const raw = new DatabaseSync(join(path, 'state.sqlite'));
      raw.prepare('UPDATE state_migrations SET checksum=?').run('private-diagnostic');
      raw.close();
      const mismatch = await openSqliteState({ schemaVersion: 1, stateDirectory: path });

      assert.equal(rejectedCode(mismatch), 'state_schema_mismatch');
      assert.doesNotMatch(JSON.stringify(mismatch), /private-diagnostic/);

      const path2 = join(directory, 'state-2');
      const second = await open(path2);
      setup(second, directory);
      const corrupt = new DatabaseSync(join(path2, 'state.sqlite'));
      corrupt
        .prepare("UPDATE jobs SET data=json_set(data, '$.intent', ?) WHERE id=?")
        .run('private-diagnostic', 'job');
      corrupt.close();

      try {
        const result = inspectStateRecord({ schemaVersion: 1, entity: 'job', id: 'job' }, second);

        assert.equal(rejectedCode(result), 'state_invalid_data');
        assert.doesNotMatch(JSON.stringify(result), /private-diagnostic/);
      } finally {
        second.close();
      }
    });
  },
);

await test(
  'closed connections reject operations and close remains idempotent',
  options,
  async () => {
    await temporary(async (directory) => {
      const store = await open(join(directory, 'state'));
      store.close();

      assert.equal(rejectedCode(saveStateProject(identity(directory), store)), 'state_closed');
      assert.equal(
        rejectedCode(inspectStateRecord({ schemaVersion: 1, entity: 'job', id: 'job' }, store)),
        'state_closed',
      );
      assert.equal(store.close().outcome, 'completed');
    });
  },
);

await test(
  'compiled distribution opens and migrates state independently of cwd',
  options,
  async () => {
    await temporary(async (directory) => {
      const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
      const { openSqliteState } = await import(process.argv[1]);
      const result = await openSqliteState({ schemaVersion: 1, stateDirectory: process.argv[2] });
      if (result.outcome !== 'opened') { process.exit(2); }
      result.store.close();
    `,
          entrypoint,
          join(directory, 'packaged-state'),
        ],
        { cwd: directory, env: {}, encoding: 'utf8', timeout: 5000 },
      );

      assert.equal(child.status, 0, child.stderr);
    });
  },
);

await test(
  'lost commit acknowledgement returns uncertainty and requires reopening before reuse',
  options,
  async () => {
    await temporary(async (directory) => {
      const path = join(directory, 'state.sqlite');
      const database = openStateDatabase(path, 25);
      database
        .statement('CREATE TABLE evidence (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
        .run();
      const commit = database.statement('COMMIT');
      const run = commit.run.bind(commit);
      commit.run = () => {
        run();

        throw new Error('private-lost-commit-ack');
      };

      const result = database.write(() => {
        database
          .statement('INSERT INTO evidence(id, value) VALUES (?, ?)')
          .run('stable-id', 'durable');

        return { disposition: 'created', value: { id: 'stable-id' } };
      });

      assert.equal(result.outcome, 'uncertain');
      assert.doesNotMatch(JSON.stringify(result), /private-lost-commit-ack/);
      assert.equal(rejectedCode(database.read(() => null)), 'state_closed');

      database.close();
      const reopened = openStateDatabase(path, 25);

      try {
        assert.equal(
          reopened.statement('SELECT value FROM evidence WHERE id=?').get('stable-id')?.value,
          'durable',
        );
      } finally {
        reopened.close();
      }
    });
  },
);
