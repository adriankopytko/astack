import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureHerdrProject,
  inspectHerdrProject,
  prepareHerdrWorker,
  inspectHerdrWorker,
  bindHerdrAgent,
  reconcileHerdrSpace,
  configureHerdrProject,
  createHerdrCliProvider,
  herdrResultSchema,
  processRequestSchema,
  type HerdrTarget,
  type HerdrResult,
  type ProcessRequest,
  type ProcessResult,
} from '../src/index.js';
import { fixture, space } from './support/herdr.js';

const options = { timeout: 90_000 };
const project = { schemaVersion: 1, projectId: 'project-0' };
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
function reason(value: HerdrResult): string | null {
  herdrResultSchema.parse(value);

  return 'reason' in value ? value.reason : value.error.code;
}

function execution(body: unknown): ProcessResult {
  const text = JSON.stringify(body);
  const output = (text: string) => ({
    text,
    capturedBytes: Buffer.byteLength(text),
    observedBytes: Buffer.byteLength(text),
    complete: true,
    truncated: false,
    artifact: null,
  });

  return {
    schemaVersion: 1,
    outcome: 'exited',
    pid: 123,
    exitCode: 0,
    signal: null,
    error: null,
    stdout: output(text),
    stderr: output(''),
    shutdown: { root: 'exited', processGroup: 'absent', termSent: false, killSent: false },
  };
}

await test(
  'primary spaces use saved canonical projects, never labels or ambient caller context',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, sources }) => {
      await configure(0, 'default', 'same-label');
      await configure(1, 'default', 'same-label');
      const first = space(await ensureHerdrProject(project, deps), 'prepared');
      const second = space(
        await ensureHerdrProject({ ...project, projectId: 'project-1' }, deps),
        'prepared',
      );

      assert.notEqual(first.handle?.workspaceId, second.handle?.workspaceId);
      assert.equal(first.root, sources[0]);
      assert.equal(second.root, sources[1]);
      assert.deepEqual(first.target, second.target);
      assert.equal(fake.calls.length, 2);

      const repeated = space(await ensureHerdrProject(project, deps), 'reused');

      assert.deepEqual(repeated, first);
      assert.equal(fake.calls.length, 2);
    });
  },
);

await test(
  'unambiguous existing primary is associated without taking ownership of its agents',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, sources, opened }) => {
      await configure();
      const settings = opened.herdr.settings('project-0');

      if (settings.outcome !== 'completed' || !settings.value) {
        assert.fail('Missing settings');
      }

      const handle = fake.add(settings.value.target, sources[0] ?? '', 'user-workspace');
      const reused = space(await ensureHerdrProject(project, deps), 'reused');

      assert.deepEqual(reused.handle, handle);
      assert.equal(reused.agent, null);
      assert.equal(fake.calls.length, 0);

      fake.add(settings.value.target, sources[0] ?? '', 'another-matching-workspace');
      const ambiguous = await ensureHerdrProject(project, deps);

      assert.equal(reason(ambiguous), 'ambiguous');
      assert.equal(fake.calls.length, 0);
    });
  },
);

await test(
  'shared default session and explicit isolated session are persisted and never retargeted implicitly',
  options,
  async () => {
    await fixture(async ({ configure, deps }) => {
      await configure(0);
      await configure(1, 'isolated');
      const first = space(await ensureHerdrProject(project, deps));
      const isolated = space(
        await ensureHerdrProject({ ...project, projectId: 'project-1' }, deps),
      );

      assert.equal(first.target.session, 'default');
      assert.equal(isolated.target.session, 'isolated');
      assert.notEqual(first.target.socketPath, isolated.target.socketPath);

      const conflict = await configureHerdrProject({ ...project, target: isolated.target }, deps);

      assert.equal(conflict.outcome === 'rejected' && conflict.error.code, 'herdr_conflict');
    });
  },
);

await test(
  'concurrent ensures publish one layout writer and pending writes are not retried',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake }) => {
      await configure();
      const values = await Promise.all([
        ensureHerdrProject(project, deps),
        ensureHerdrProject(project, deps),
      ]);

      assert.equal(fake.calls.length, 1);
      assert.ok(values.some((value) => value.outcome === 'prepared'));
      assert.ok(values.every((value) => ['prepared', 'pending', 'reused'].includes(value.outcome)));
    });
  },
);

await test(
  'uncertain primary creation is reconciled only after operation-bound host attestation',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake }) => {
      await configure();
      fake.modes.create = 'after';
      const pending = space(await ensureHerdrProject(project, deps), 'pending');
      const repeated = await ensureHerdrProject(project, deps);

      assert.equal(repeated.outcome, 'pending');
      assert.equal(fake.calls.length, 1);

      const wrong = await reconcileHerdrSpace(
        { schemaVersion: 1, id: pending.id, operationId: 'wrong', writerStopped: true },
        deps,
      );

      assert.equal(reason(wrong), 'herdr_conflict');

      const reconciled = space(
        await reconcileHerdrSpace(
          {
            schemaVersion: 1,
            id: pending.id,
            operationId: pending.operationId,
            writerStopped: true,
          },
          deps,
        ),
        'reconciled',
      );

      assert.equal(reconciled.phase, 'ready');
      assert.equal(fake.calls.length, 1);
    });
  },
);

await test(
  'primary missing after restart is restored; changed worker epochs are blocked',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, worker }) => {
      await configure();
      const job = await worker();
      const owned = space(
        await prepareHerdrWorker({ schemaVersion: 1, attemptId: job.attempt.id }, deps),
        'prepared',
      );
      const snapshot = fake.snapshot(owned.target);
      snapshot.server.changedAtNs = '2';
      const workerStatus = await inspectHerdrWorker(
        { schemaVersion: 1, attemptId: job.attempt.id },
        deps,
      );

      assert.equal(reason(workerStatus), 'server_changed');

      snapshot.workspaces = [];
      snapshot.tabs = [];
      snapshot.panes = [];
      const primary = space(await ensureHerdrProject(project, deps), 'prepared');

      assert.equal(primary.server.changedAtNs, '2');
      assert.notEqual(primary.handle?.workspaceId, owned.primaryWorkspaceId);
      assert.equal(fake.calls.filter((call) => call.operation === 'open').length, 1);
    });
  },
);

await test(
  'owned workers open as grouped workspaces and persist exact agent attribution without launching agents',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, worker, opened }) => {
      await configure();
      const job = await worker();
      const prepared = space(
        await prepareHerdrWorker({ schemaVersion: 1, attemptId: job.attempt.id }, deps),
        'prepared',
      );

      assert.ok(prepared.handle);
      assert.ok(prepared.expectedAgentName);
      assert.notEqual(prepared.handle.workspaceId, prepared.primaryWorkspaceId);
      assert.equal(prepared.checkoutId, job.job.checkoutId);
      assert.equal(fake.calls.filter((call) => call.operation === 'open').length, 1);

      const snapshot = fake.snapshot(prepared.target);
      snapshot.agents.push({
        ...prepared.handle,
        name: prepared.expectedAgentName,
        kind: 'codex',
        nativeSessionId: 'fixture-native-session',
        cwd: prepared.root,
        foregroundCwd: prepared.root,
        status: 'idle',
      });
      const bound = space(
        await bindHerdrAgent({ schemaVersion: 1, attemptId: job.attempt.id, kind: 'codex' }, deps),
        'reconciled',
      );

      assert.equal(bound.agent?.name, prepared.expectedAgentName);
      assert.equal(bound.agent?.nativeSessionId, 'fixture-native-session');

      const inspected = await inspectHerdrWorker(
        { schemaVersion: 1, attemptId: job.attempt.id },
        deps,
      );

      assert.equal(inspected.outcome, 'inspected');
      assert.equal('observation' in inspected && inspected.observation?.agentStatus, 'idle');

      const repeated = space(
        await prepareHerdrWorker({ schemaVersion: 1, attemptId: job.attempt.id }, deps),
        'reused',
      );

      assert.equal(repeated.handle?.terminalId, bound.handle?.terminalId);
      assert.equal(fake.calls.filter((call) => call.operation === 'open').length, 1);

      const primary = await inspectHerdrProject(project, deps);

      assert.equal(primary.outcome, 'inspected');
      assert.equal(opened.herdr.worker(job.attempt.id).outcome, 'completed');
      assert.equal(
        opened.store.inspectRecord({
          schemaVersion: 1,
          entity: 'resource',
          id: `herdr:${prepared.id}`,
        }).outcome,
        'completed',
      );

      const occupant = snapshot.agents[0];

      assert.ok(occupant);

      occupant.status = 'done';
      const done = await inspectHerdrWorker({ schemaVersion: 1, attemptId: job.attempt.id }, deps);
      const attempt = opened.store.inspectRecord({
        schemaVersion: 1,
        entity: 'attempt',
        id: job.attempt.id,
      });

      assert.equal('observation' in done && done.observation?.agentStatus, 'done');
      assert.equal(
        attempt.outcome === 'completed' &&
          attempt.value?.entity === 'attempt' &&
          attempt.value.resolvedAt,
        null,
      );
      assert.deepEqual(await inspectHerdrProject(project, deps), primary);
      assert.equal(
        opened.store.inspectRecord({
          schemaVersion: 1,
          entity: 'resource',
          id: `agent:${prepared.id}`,
        }).outcome,
        'completed',
      );
    });
  },
);

await test(
  'wrong agent cwd, replacement terminal and moved pane never silently change attribution',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, worker }) => {
      await configure();
      const job = await worker();
      const prepared = space(
        await prepareHerdrWorker({ schemaVersion: 1, attemptId: job.attempt.id }, deps),
      );

      assert.ok(prepared.handle && prepared.expectedAgentName);

      const snapshot = fake.snapshot(prepared.target);
      const agent = {
        ...prepared.handle,
        name: prepared.expectedAgentName,
        kind: 'codex',
        nativeSessionId: 'native',
        cwd: prepared.root,
        foregroundCwd: '/wrong-project',
        status: 'working' as const,
      };
      snapshot.agents.push(agent);
      const wrong = await bindHerdrAgent(
        { schemaVersion: 1, attemptId: job.attempt.id, kind: 'codex' },
        deps,
      );

      assert.equal(reason(wrong), 'agent_mismatch');

      agent.foregroundCwd = prepared.root;
      space(
        await bindHerdrAgent({ schemaVersion: 1, attemptId: job.attempt.id, kind: 'codex' }, deps),
        'reconciled',
      );
      agent.nativeSessionId = 'replacement';
      const replacement = await inspectHerdrWorker(
        { schemaVersion: 1, attemptId: job.attempt.id },
        deps,
      );

      assert.equal(reason(replacement), 'agent_mismatch');

      const pane = snapshot.panes.find((pane) => pane.paneId === prepared.handle?.paneId);

      assert.ok(pane);

      pane.terminalId = 'replacement-terminal';
      const moved = await inspectHerdrWorker({ schemaVersion: 1, attemptId: job.attempt.id }, deps);

      assert.equal(reason(moved), 'layout_changed');
    });
  },
);

await test(
  'unowned existing worker layout and lost open acknowledgement are preserved',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, worker }) => {
      await configure();
      const job = await worker();
      fake.modes.open = 'after';
      const pending = space(
        await prepareHerdrWorker({ schemaVersion: 1, attemptId: job.attempt.id }, deps),
        'pending',
      );
      const repeated = await prepareHerdrWorker(
        { schemaVersion: 1, attemptId: job.attempt.id },
        deps,
      );

      assert.equal(repeated.outcome, 'pending');
      assert.equal(fake.calls.filter((call) => call.operation === 'open').length, 1);

      space(
        await reconcileHerdrSpace(
          {
            schemaVersion: 1,
            id: pending.id,
            operationId: pending.operationId,
            writerStopped: true,
          },
          deps,
        ),
        'reconciled',
      );
      const other = await worker('other-worker');
      const checkout = await deps.registry.readCheckout(other.job.checkoutId);

      assert.equal(checkout.outcome, 'completed');

      if (checkout.outcome !== 'completed' || !checkout.value) {
        assert.fail('Missing checkout');
      }

      fake.add(
        pending.target,
        checkout.value.checkout.rootPath,
        'unowned-worker',
        pending.primaryRoot ?? '',
      );
      const unowned = await prepareHerdrWorker(
        { schemaVersion: 1, attemptId: other.attempt.id },
        deps,
      );

      assert.equal(reason(unowned), 'unowned_workspace');
      assert.equal(fake.calls.filter((call) => call.operation === 'open').length, 1);
    });
  },
);

await test(
  'missing providers and invalid/cancelled requests never fall back to another runtime',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake }) => {
      const missing = await ensureHerdrProject(project, deps);

      assert.equal(reason(missing), 'herdr_not_configured');

      await configure();
      fake.modes.unavailable = true;
      const failed = await ensureHerdrProject(project, deps);

      assert.equal(reason(failed), 'herdr_unavailable');
      assert.equal(JSON.stringify(failed).includes('fixture-private-provider-error'), false);
      assert.equal(fake.calls.length, 0);

      const controller = new AbortController();
      controller.abort();
      const cancelled = await ensureHerdrProject(project, deps, controller.signal);
      const invalid = await prepareHerdrWorker({ schemaVersion: 2, attemptId: 'example' }, deps);

      assert.equal(reason(cancelled), 'cancelled');
      assert.equal(reason(invalid), 'unsupported_contract_version');
    });
  },
);

await test('CLI provider uses explicit endpoint environment and no-focus argv, discarding metadata and raw diagnostics', async () => {
  const target: HerdrTarget = { session: 'default', socketPath: '/fixture/herdr.sock' };
  const requests: ProcessRequest[] = [];
  const provider = createHerdrCliProvider({
    executable: '/fixture/herdr',
    endpoint: {
      async read(target) {
        return { ...target, device: '1', inode: '1', changedAtNs: '1' };
      },
    },
    environment: {
      HERDR_PANE_ID: 'ambient-pane',
      HERDR_WORKSPACE_ID: 'ambient-workspace',
      HERDR_SOCKET_PATH: '/wrong.sock',
      TOKEN: 'fixture-secret',
    },
    runner: {
      async run(input) {
        requests.push(processRequestSchema.parse(input));
        const command = input.args.join(' ');

        if (command === 'api snapshot') {
          return execution({
            result: {
              type: 'session_snapshot',
              snapshot: {
                protocol: 22,
                workspaces: [],
                tabs: [],
                panes: [],
                agents: [],
                metadata: 'fixture-secret',
              },
            },
          });
        }

        return execution({
          result: {
            type: input.args[0] === 'workspace' ? 'workspace_created' : 'worktree_opened',
            already_open: false,
          },
        });
      },
    },
  });
  const observed = await provider.snapshot(target, '/fixture/project');

  assert.equal(observed.outcome, 'completed');
  assert.equal(JSON.stringify(observed).includes('fixture-secret'), false);

  if (observed.outcome !== 'completed') {
    assert.fail('Missing snapshot');
  }

  await provider.createPrimary({
    target,
    server: observed.value.server,
    root: '/fixture/project',
    label: 'Project; literal',
  });
  await provider.openWorker({
    target,
    server: observed.value.server,
    root: '/fixture/worktree',
    parent: 'w-parent',
    label: 'worker',
  });

  assert.equal(requests.length, 3);

  for (const request of requests) {
    assert.equal(request.env.HERDR_SOCKET_PATH, target.socketPath);
    assert.equal(request.env.HERDR_SESSION, 'default');
    assert.equal(request.env.HERDR_PANE_ID, undefined);
    assert.equal(request.env.HERDR_WORKSPACE_ID, undefined);
    assert.equal(request.env.TOKEN, undefined);
  }

  assert.deepEqual(requests[1]?.args, [
    'workspace',
    'create',
    '--cwd',
    '/fixture/project',
    '--label',
    'Project; literal',
    '--no-focus',
  ]);
  assert.deepEqual(requests[2]?.args, [
    'worktree',
    'open',
    '--workspace',
    'w-parent',
    '--path',
    '/fixture/worktree',
    '--label',
    'worker',
    '--no-focus',
  ]);
});

await test('CLI provider rejects unsupported protocols, truncated output and endpoint changes', async () => {
  const target = { session: 'default', socketPath: '/fixture/herdr.sock' };
  let epoch = '1';
  let mode = 'protocol';
  const provider = createHerdrCliProvider({
    executable: '/fixture/herdr',
    endpoint: {
      async read(target) {
        return { ...target, device: '1', inode: epoch, changedAtNs: '1' };
      },
    },
    runner: {
      async run() {
        const value = execution({
          result: {
            type: 'session_snapshot',
            snapshot: {
              protocol: mode === 'protocol' ? 21 : 22,
              workspaces: [],
              tabs: [],
              panes: [],
              agents: [],
            },
          },
        });

        if (value.outcome === 'rejected') {
          assert.fail('Invalid fixture');
        }

        if (mode === 'truncated') {
          value.stdout.observedBytes++;
          value.stdout.truncated = true;
        }

        if (mode === 'epoch') {
          epoch = '2';
        }

        return value;
      },
    },
  });
  const unsupported = await provider.snapshot(target, '/fixture');

  assert.equal(unsupported.outcome === 'rejected' && unsupported.error.code, 'herdr_unsupported');

  mode = 'truncated';
  const truncated = await provider.snapshot(target, '/fixture');

  assert.equal(truncated.outcome, 'rejected');

  mode = 'epoch';
  const changed = await provider.snapshot(target, '/fixture');

  assert.equal(changed.outcome === 'rejected' && changed.error.code, 'herdr_conflict');
});

await test(
  'compiled CLI configures and reports Herdr blockers from a neutral cwd without live-provider calls',
  options,
  async () => {
    await fixture(async ({ state, root }) => {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          '--state-directory',
          state,
          'herdr',
          'configure',
          '--project',
          'project-0',
          '--socket',
          `${root}/missing.sock`,
          '--json',
        ],
        {
          cwd: root,
          env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
          encoding: 'utf8',
          timeout: 15_000,
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"session":"default"/);

      const inspected = spawnSync(
        process.execPath,
        [cli, '--state-directory', state, 'herdr', 'inspect', '--project', 'project-0', '--json'],
        {
          cwd: root,
          env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
          encoding: 'utf8',
          timeout: 15_000,
        },
      );

      assert.equal(inspected.status, 1);
      assert.match(inspected.stdout, /herdr_unavailable/);
    });
  },
);
