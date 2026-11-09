import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentPorts } from '../src/application/agent-ports.js';
import {
  prepareWorkerWorktree,
  reconcileWorkerWorktree,
} from '../src/application/worker-worktree.js';
import { submitWorkerTask } from '../src/application/worker-submission.js';
import { nodeImplementationContextReader } from '../src/adapters/filesystem/implementation-context.js';
import { sha256 } from '../src/core/file-paths.js';
import { createReviewCommitFetcher } from '../src/adapters/git/review-commit.js';
import {
  executeCleanup,
  type CleanupDependencies,
  type CleanupPlan,
  type RunView,
} from '../src/index.js';
import {
  createWorktreeGit,
  createNodeWorktreeFiles,
  nodeProcessRunner,
  submitServiceJob,
} from '../src/index.js';
import { git, gitPath, writeProjectConfiguration } from './support/service.js';
import { completed } from '../src/contracts/operation-result.js';
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
  startLocalService,
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
  'primary spaces reuse matching names even when projects have different roots',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, sources }) => {
      await configure(0, 'default', 'same-label');
      await configure(1, 'default', 'same-label');
      const first = space(await ensureHerdrProject(project, deps), 'prepared');
      const second = space(
        await ensureHerdrProject({ ...project, projectId: 'project-1' }, deps),
        'reused',
      );

      assert.equal(first.handle?.workspaceId, second.handle?.workspaceId);
      assert.equal(first.root, sources[0]);
      assert.equal(second.root, sources[1]);
      assert.deepEqual(first.target, second.target);
      assert.equal(fake.calls.length, 1);

      const repeated = space(await ensureHerdrProject(project, deps), 'reused');

      assert.deepEqual(repeated, first);
      assert.equal(fake.calls.length, 1);
    });
  },
);

await test(
  'existing workspace is reused by name without taking ownership of its agents',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, sources, opened }) => {
      await configure();
      const settings = opened.herdr.settings('project-0');

      if (settings.outcome !== 'completed' || !settings.value) {
        assert.fail('Missing settings');
      }

      const handle = fake.add(settings.value.target, '/another-project', settings.value.label);
      const reused = space(await ensureHerdrProject(project, deps), 'reused');

      assert.deepEqual(reused.handle, handle);
      assert.equal(reused.agent, null);
      assert.equal(fake.calls.length, 0);

      fake.add(settings.value.target, sources[0] ?? '', settings.value.label);
      const repeated = space(await ensureHerdrProject(project, deps), 'reused');

      assert.deepEqual(repeated.handle, handle);
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
      assert.equal(fake.calls.filter((call) => call.operation === 'attach').length, 1);
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
      assert.equal(fake.calls.filter((call) => call.operation === 'attach').length, 1);

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
      assert.equal(fake.calls.filter((call) => call.operation === 'attach').length, 1);

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
      assert.equal(fake.calls.filter((call) => call.operation === 'attach').length, 1);

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
      assert.equal(fake.calls.filter((call) => call.operation === 'attach').length, 1);
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

await test(
  'Herdr worktree preparation records one owned checkout and reuses its saved intent',
  options,
  async () => {
    await fixture(async ({ configure, deps, opened, fake, state, sources }) => {
      await configure();
      let created = 0;
      let sequence = 0;
      let attached = 0;
      const provider = {
        ...fake.provider,
        async attachWorker() {
          attached++;

          return completed({});
        },
        async createWorker(
          input: NonNullable<Parameters<NonNullable<typeof fake.provider.createWorker>>[0]>,
        ) {
          created++;
          git(
            input.sourceRoot,
            'worktree',
            'add',
            '-b',
            input.branch,
            input.root,
            input.baseCommit,
          );
          const handle = fake.add(input.target, input.root, input.label, input.sourceRoot);

          return completed({ workspaceId: handle.workspaceId });
        },
      };
      const managedRoot = join(state, 'worktrees');
      const worktrees = {
        ...deps,
        store: opened.worktrees,
        files: createNodeWorktreeFiles(managedRoot),
        effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
        managedRoot,
        nextId: (kind: 'worktree' | 'checkout' | 'operation' | 'marker') =>
          `${kind}-combined-${++sequence}`,
        now: () => 1000,
      };
      const request = {
        schemaVersion: 1,
        projectId: 'project-0',
        key: 'combined',
        branch: 'refs/heads/astack/code-review-combined',
        baseCommit: git(sources[0]!, 'rev-parse', 'HEAD'),
      };
      const first = await prepareWorkerWorktree(request, {
        worktrees,
        herdr: { ...deps, provider },
      });
      const second = await prepareWorkerWorktree(request, {
        worktrees,
        herdr: { ...deps, provider },
      });

      assert.equal(first.outcome, 'prepared', JSON.stringify(first));
      assert.equal(second.outcome, 'reused', JSON.stringify(second));
      assert.equal(created, 1);
      assert.ok('record' in first && first.record?.workspace);

      const accepted = await submitServiceJob(
        {
          schemaVersion: 1,
          projectId: 'project-0',
          checkoutId: first.record.intent.checkoutId,
          role: 'implementer',
          key: 'combined-job',
          branch: request.branch,
          commit: request.baseCommit,
          task: {},
          request: {},
        },
        {
          ...deps,
          queue: opened.service,
          now: () => 1000,
          nextId: (kind) => `${kind}-combined-job-${++sequence}`,
        },
      );

      assert.equal(accepted.outcome, 'persisted', JSON.stringify(accepted));

      if (accepted.outcome !== 'persisted') {
        return;
      }

      const bound = await prepareHerdrWorker(
        { schemaVersion: 1, attemptId: accepted.value.attempt.id },
        { ...deps, provider },
      );

      assert.equal(bound.outcome, 'prepared', JSON.stringify(bound));
      assert.equal(attached, 1);
      assert.equal(fake.calls.filter((call) => call.operation === 'attach').length, 0);
    });
  },
);

await test(
  'lost Herdr worktree acknowledgement keeps a pending intent without duplicate creation',
  options,
  async () => {
    await fixture(async ({ configure, deps, opened, fake, state, sources }) => {
      await configure();
      let calls = 0;
      let sequence = 0;
      const provider = {
        ...fake.provider,
        async createWorker(
          input: NonNullable<Parameters<NonNullable<typeof fake.provider.createWorker>>[0]>,
        ) {
          calls++;
          git(
            input.sourceRoot,
            'worktree',
            'add',
            '-b',
            input.branch,
            input.root,
            input.baseCommit,
          );
          fake.add(input.target, input.root, input.label, input.sourceRoot);

          throw new Error('response lost');
        },
      };
      const managedRoot = join(state, 'worktrees');
      const worktrees = {
        ...deps,
        store: opened.worktrees,
        files: createNodeWorktreeFiles(managedRoot),
        effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
        managedRoot,
        nextId: (kind: 'worktree' | 'checkout' | 'operation' | 'marker') =>
          `${kind}-lost-${++sequence}`,
        now: () => 1000,
      };
      const request = {
        schemaVersion: 1,
        projectId: 'project-0',
        key: 'lost',
        branch: 'refs/heads/astack/lost',
        baseCommit: git(sources[0]!, 'rev-parse', 'HEAD'),
      };
      const first = await prepareWorkerWorktree(request, {
        worktrees,
        herdr: { ...deps, provider },
      });
      const second = await prepareWorkerWorktree(request, {
        worktrees,
        herdr: { ...deps, provider },
      });

      assert.equal(first.outcome, 'pending');
      assert.equal(second.outcome, 'pending');
      assert.equal(calls, 1);
      assert.ok('record' in first && first.record);

      const reconciled = await reconcileWorkerWorktree(
        {
          schemaVersion: 1,
          id: first.record.intent.id,
          operationId: first.record.operationId,
          writerStopped: true,
        },
        { worktrees, herdr: { ...deps, provider } },
      );

      assert.equal(reconciled.outcome, 'reconciled', JSON.stringify(reconciled));
      assert.ok('record' in reconciled && reconciled.record?.workspace);

      const afterRecovery = await prepareWorkerWorktree(request, {
        worktrees,
        herdr: { ...deps, provider },
      });

      assert.equal(afterRecovery.outcome, 'reused', JSON.stringify(afterRecovery));
      assert.equal(calls, 1);
    });
  },
);

await test(
  'task submission automatically creates separate implementation and review worktrees',
  options,
  async () => {
    await fixture(async ({ configure, deps, opened, fake, state, sources }) => {
      await configure();
      let sequence = 0;
      let creates = 0;
      const provider = {
        ...fake.provider,
        async createWorker(
          input: NonNullable<Parameters<NonNullable<typeof fake.provider.createWorker>>[0]>,
        ) {
          creates++;
          git(
            input.sourceRoot,
            'worktree',
            'add',
            '-b',
            input.branch,
            input.root,
            input.baseCommit,
          );
          const handle = fake.add(input.target, input.root, input.label, input.sourceRoot);

          return completed({ workspaceId: handle.workspaceId });
        },
      };
      const managedRoot = join(state, 'worktrees');
      const files = createNodeWorktreeFiles(managedRoot);
      const worktrees = {
        ...deps,
        store: opened.worktrees,
        files,
        effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
        managedRoot,
        nextId: (kind: 'worktree' | 'checkout' | 'operation' | 'marker') =>
          `${kind}-auto-${++sequence}`,
        now: () => 1000,
      };
      const implementation = {
        ...deps,
        queue: opened.service,
        worktrees: opened.worktrees,
        files,
        instructions: nodeImplementationContextReader,
        now: () => 1000,
        nextId: (kind: 'job' | 'attempt' | 'effect' | 'claim') => `${kind}-auto-${++sequence}`,
      };
      const sha = git(sources[0]!, 'rev-parse', 'HEAD');
      const target = { host: 'github.com', repository: 'example/project', number: 1, sha };
      const review = {
        ...implementation,
        targets: {
          read: async () =>
            completed({
              target,
              baseSha: sha,
              state: 'OPEN' as const,
              draft: false,
              sourceRepository: 'example/project',
              checks: [],
              observedAt: 1000,
            }),
        },
      };
      const dependencies = { implementation, review, worktrees, herdr: { ...deps, provider } };
      const input = {
        schemaVersion: 1,
        projectId: 'project-0',
        key: 'build-task',
        description: 'Implement a small task',
      };
      const first = await submitWorkerTask('implementer', input, dependencies);
      const repeated = await submitWorkerTask('implementer', input, dependencies);
      const reviewed = await submitWorkerTask(
        'reviewer',
        { schemaVersion: 1, projectId: 'project-0', key: 'review-task', target },
        dependencies,
      );

      const alias = await submitWorkerTask(
        'reviewer',
        { schemaVersion: 1, projectId: 'project-0', key: 'review-alias', target },
        dependencies,
      );

      assert.equal(first.outcome, 'persisted', JSON.stringify(first));
      assert.equal(repeated.outcome, 'persisted', JSON.stringify(repeated));
      assert.equal(reviewed.outcome, 'persisted', JSON.stringify(reviewed));
      assert.equal(alias.outcome, 'persisted', JSON.stringify(alias));
      assert.equal(creates, 2);
      assert.ok(first.outcome === 'persisted' && reviewed.outcome === 'persisted');
      assert.notEqual(first.value.job.job.checkoutId, reviewed.value.job.job.checkoutId);
      assert.match(reviewed.value.job.entry.branch, /^refs\/heads\/astack\/code-review-/);
      assert.equal(reviewed.value.job.entry.commit, sha);
    });
  },
);

await test(
  'CLI delegates implementation and review without a prepared checkout',
  options,
  async () => {
    await fixture(async ({ configure, opened, fake, state, sources }) => {
      await configure();
      await writeProjectConfiguration({ state, sources }, 0);
      const configPath = join(sources[0]!, '.astack', 'config.json');
      const projectConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
        agents: { implementer: { workspacePrefix?: string } };
      };
      projectConfig.agents.implementer.workspacePrefix = 'DEV';
      await writeFile(configPath, JSON.stringify(projectConfig));
      let creates = 0;
      const labels: string[] = [];
      let loseResponse = false;
      const provider = {
        ...fake.provider,
        async createWorker(
          input: NonNullable<Parameters<NonNullable<typeof fake.provider.createWorker>>[0]>,
        ) {
          creates++;
          labels.push(input.label);
          git(
            input.sourceRoot,
            'worktree',
            'add',
            '-b',
            input.branch,
            input.root,
            input.baseCommit,
          );
          const handle = fake.add(input.target, input.root, input.label, input.sourceRoot);

          if (loseResponse) {
            loseResponse = false;

            throw new Error('lost creation response');
          }

          return completed({ workspaceId: handle.workspaceId });
        },
      };
      const sha = git(sources[0]!, 'rev-parse', 'HEAD');
      const target = { host: 'github.com', repository: 'example/project', number: 1, sha };
      const service = await startLocalService(
        { schemaVersion: 1, stateDirectory: state, gitExecutable: gitPath },
        {
          workerSetupProvider: provider,
          reviewTargets: {
            read: async () =>
              completed({
                target,
                baseSha: sha,
                state: 'OPEN',
                draft: false,
                sourceRepository: 'example/project',
                checks: [],
                observedAt: 1000,
              }),
          },
        },
      );

      assert.equal(service.outcome, 'listening', JSON.stringify(service));

      if (service.outcome !== 'listening') {
        return;
      }

      try {
        const run = async (args: string[], cwd?: string) =>
          new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [cli, '--state-directory', state, ...args, '--json'],
              { cwd },
            );
            let stdout = '';
            child.stdout.on('data', (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout }));
          });
        const implementation = await run(
          ['implement', 'submit', '--key', 'task', '--task', 'Implement a task'],
          sources[0],
        );
        const unspecified = await run(
          ['implement', 'submit', '--key', 'no-project', '--task', 'test'],
          state,
        );

        assert.equal(unspecified.code, 1);
        assert.match(unspecified.stdout, /project_context_required/);

        const repeated = await run([
          'implement',
          'submit',
          '--project',
          'project-0',
          '--key',
          'task',
          '--task',
          'Implement a task',
        ]);
        const review = await run(
          [
            'review',
            'submit',
            '--key',
            'review',
            '--repo',
            'example/project',
            '--pr',
            '1',
            '--commit',
            sha,
          ],
          sources[0],
        );
        const implementationResult = JSON.parse(implementation.stdout) as {
          outcome: string;
          value?: { job: { job: { checkoutId: string } } };
        };
        const reviewResult = JSON.parse(review.stdout) as {
          outcome: string;
          value?: { job: { job: { checkoutId: string }; entry: { branch: string } } };
        };

        assert.equal(implementation.code, 0, implementation.stdout);
        assert.ok([0, 1].includes(repeated.code ?? -1), repeated.stdout);
        assert.equal(review.code, 0, review.stdout);
        assert.equal(implementationResult.outcome, 'persisted');
        assert.equal(reviewResult.outcome, 'persisted');
        assert.notEqual(
          implementationResult.value?.job.job.checkoutId,
          reviewResult.value?.job.job.checkoutId,
        );
        assert.match(reviewResult.value!.job.entry.branch, /^refs\/heads\/astack\/code-review-/);
        assert.equal(creates, 2);
        assert.match(labels[0]!, /^DEV-/);
        assert.match(labels[1]!, /^CR-/);

        loseResponse = true;
        const lostTask = [
          'implement',
          'submit',
          '--project',
          'project-0',
          '--key',
          'lost-task',
          '--task',
          'Implement another task',
        ];
        const lost = await run(lostTask);

        assert.equal(lost.code, 1, lost.stdout);
        assert.match(lost.stdout, /state_reconciliation_required/);

        const digest = sha256('project-0\0implementer\0lost-task').slice(0, 32);
        const saved = opened.worktrees.find('project-0', `worker-implementer-${digest}`);

        assert.ok(saved.outcome === 'completed' && saved.value);

        const recovery = await run([
          'worktree',
          'reconcile',
          saved.value.intent.id,
          '--operation',
          saved.value.operationId,
          '--writer-stopped',
        ]);

        assert.equal(recovery.code, 0, recovery.stdout);
        assert.match(recovery.stdout, /reconciled/);

        const resumed = await run(lostTask);

        assert.equal(resumed.code, 0, resumed.stdout);
        assert.equal(creates, 3);
      } finally {
        await service.close();
      }
    });
  },
);

await test(
  'cleanup deletes only the generated reviewer branch after removing its checkout',
  options,
  async () => {
    await fixture(async ({ configure, deps, opened, fake, state, sources, root }) => {
      await configure();
      let sequence = 0;
      const taskKey = 'review-for-cleanup';
      const digest = sha256(`project-0\0reviewer\0${taskKey}`).slice(0, 32);
      const branch = `refs/heads/astack/code-review-${digest}`;
      const provider = {
        ...fake.provider,
        async createWorker(
          input: NonNullable<Parameters<NonNullable<typeof fake.provider.createWorker>>[0]>,
        ) {
          git(
            input.sourceRoot,
            'worktree',
            'add',
            '-b',
            input.branch,
            input.root,
            input.baseCommit,
          );
          const handle = fake.add(input.target, input.root, input.label, input.sourceRoot);

          return completed({ workspaceId: handle.workspaceId });
        },
      };
      const managedRoot = join(state, 'worktrees');
      const worktrees = {
        ...deps,
        store: opened.worktrees,
        files: createNodeWorktreeFiles(managedRoot),
        effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
        managedRoot,
        nextId: (kind: 'worktree' | 'checkout' | 'operation' | 'marker') =>
          `${kind}-review-cleanup-${++sequence}`,
        now: () => 1000,
      };
      const sha = git(sources[0]!, 'rev-parse', 'HEAD');
      git(sources[0]!, 'branch', 'keep-implementation', sha);
      const prepared = await prepareWorkerWorktree(
        {
          schemaVersion: 1,
          projectId: 'project-0',
          key: `worker-reviewer-${digest}`,
          branch,
          baseCommit: sha,
        },
        { worktrees, herdr: { ...deps, provider } },
      );

      assert.ok(prepared.outcome === 'prepared', JSON.stringify(prepared));

      let plan: CleanupPlan = {
        schemaVersion: 1,
        id: 'cleanup-review',
        request: {
          schemaVersion: 1,
          jobId: 'review-job',
          key: 'cleanup',
          automatic: false,
          notBefore: 0,
          publication: 'not_required',
        },
        projectId: 'project-0',
        repositoryId: prepared.record.intent.repositoryId,
        attemptId: 'review-attempt',
        checkoutId: prepared.record.intent.checkoutId,
        worktreeId: prepared.record.intent.id,
        branch,
        commit: sha,
        reportId: null,
        phase: 'requested',
        reason: null,
        revision: 0,
        createdAt: 0,
        updatedAt: 0,
      };
      const run = {
        job: {
          job: {
            projectId: 'project-0',
            idempotencyKey: taskKey,
            operation: 'delegate:reviewer',
            checkoutId: prepared.record.intent.checkoutId,
          },
          entry: { role: 'reviewer', claim: null },
        },
        cleanup: { retainedResourceCount: 0 },
        resumes: [],
      } as unknown as RunView;
      const cleanup = {
        cleanups: {
          read: () => completed(plan),
          authorize: () => completed(null),
          transition(input: { phase: CleanupPlan['phase']; reason: string | null; now: number }) {
            plan = {
              ...plan,
              phase: input.phase,
              reason: input.reason,
              revision: plan.revision + 1,
              updatedAt: input.now,
            };

            return {
              schemaVersion: 1 as const,
              outcome: 'persisted' as const,
              disposition: 'updated' as const,
              value: plan,
            };
          },
        },
        runs: { inspect: () => completed(run) },
        worktrees: {
          ...worktrees,
          store: {
            ...worktrees.store,
            beginRemoval: (...args: Parameters<typeof worktrees.store.beginRemoval>) =>
              worktrees.store.beginRemoval(args[0], args[1], args[2]),
          },
        },
        cwd: root,
        now: () => 1000,
      } as unknown as CleanupDependencies;
      const result = await executeCleanup(
        { schemaVersion: 1, jobId: 'review-job', expectedRevision: 0 },
        cleanup,
      );

      assert.ok(
        result.outcome === 'persisted' && result.value.phase === 'completed',
        JSON.stringify(result),
      );
      assert.equal(git(sources[0]!, 'branch', '--list', branch.slice('refs/heads/'.length)), '');
      assert.match(
        git(sources[0]!, 'branch', '--list', 'keep-implementation'),
        /keep-implementation/,
      );

      git(sources[0]!, 'commit', '--allow-empty', '-m', 'advance after review');
      git(sources[0]!, 'branch', branch.slice('refs/heads/'.length), 'HEAD');
      const changedHead = git(sources[0]!, 'rev-parse', branch);
      const refused = await worktrees.effects.deleteBranch!(prepared.record.intent, sha);

      assert.ok(refused.outcome !== 'exited' || refused.exitCode !== 0);
      assert.equal(git(sources[0]!, 'rev-parse', branch), changedHead);
    });
  },
);

await test('missing review commits are fetched from the exact PR without exposing credentials', async () => {
  const calls: ProcessRequest[] = [];
  let inspections = 0;
  const fetcher = createReviewCommitFetcher({
    executable: '/fixture/git',
    githubExecutable: '/fixture/gh',
    environment: { GH_TOKEN: 'secret-token' },
    runner: {
      async run(input) {
        calls.push(input);
        const value = execution('');

        if (value.outcome === 'rejected') {
          return value;
        }

        if (input.args.includes('cat-file') && inspections++ === 0) {
          value.exitCode = 1;
        }

        return value;
      },
    },
  });
  const target = {
    host: 'github.com',
    repository: 'example/project',
    number: 12,
    sha: 'a'.repeat(40),
  };
  const result = await fetcher.ensure(target, '/fixture/project');

  assert.equal(result.outcome, 'completed', JSON.stringify(result));

  const fetch = calls.find((call) => call.args.includes('fetch'));

  assert.ok(fetch);
  assert.ok(fetch.args.includes('https://github.com/example/project.git'));
  assert.ok(fetch.args.includes('refs/pull/12/head'));
  assert.equal(JSON.stringify(fetch.args).includes('secret-token'), false);
  assert.equal(calls.filter((call) => call.args.includes('cat-file')).length, 2);
});

await test('CLI provider creates a worktree and grouped workspace using an explicit base and branch', async () => {
  const target: HerdrTarget = { session: 'default', socketPath: '/fixture/herdr.sock' };
  const server = { ...target, device: '1', inode: '1', changedAtNs: '1', protocol: 22 as const };
  const requests: ProcessRequest[] = [];
  const provider = createHerdrCliProvider({
    executable: '/fixture/herdr',
    endpoint: {
      async read() {
        return server;
      },
    },
    runner: {
      async run(input) {
        requests.push(processRequestSchema.parse(input));

        return execution({
          result: { type: 'worktree_created', workspace: { workspace_id: 'w-child' } },
        });
      },
    },
  });
  const result = await provider.createWorker!({
    target,
    server,
    sourceRoot: '/fixture/project',
    root: '/fixture/task',
    parent: 'w-main',
    branch: 'astack/code-review-1',
    baseCommit: 'a'.repeat(40),
    label: 'review',
  });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(requests[0]?.args, [
    'worktree',
    'create',
    '--workspace',
    'w-main',
    '--path',
    '/fixture/task',
    '--branch',
    'astack/code-review-1',
    '--base',
    'a'.repeat(40),
    '--label',
    'review',
    '--no-focus',
  ]);
  assert.equal(requests[0]?.cwd, '/fixture/project');
});

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
            type: input.args[0] === 'workspace' ? 'workspace_created' : 'worktree_created',
            workspace: { workspace_id: 'w-child' },
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
  await provider.createWorker!({
    target,
    server: observed.value.server,
    sourceRoot: '/fixture/project',
    root: '/fixture/worktree',
    parent: 'w-parent',
    branch: 'worker-branch',
    baseCommit: 'a'.repeat(40),
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
    'create',
    '--workspace',
    'w-parent',
    '--path',
    '/fixture/worktree',
    '--branch',
    'worker-branch',
    '--base',
    'a'.repeat(40),
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

await test('CLI provider creates a port-configured tab inside the grouped worker workspace', async () => {
  const target: HerdrTarget = { session: 'default', socketPath: '/fixture/herdr.sock' };
  const server = { ...target, device: '1', inode: '1', changedAtNs: '1', protocol: 22 as const };
  const requests: ProcessRequest[] = [];
  const provider = createHerdrCliProvider({
    executable: '/fixture/herdr',
    endpoint: { read: async () => ({ ...target, device: '1', inode: '1', changedAtNs: '1' }) },
    runner: {
      run: async (input) => {
        requests.push(input);

        return execution({
          result: {
            type: 'tab_created',
            root_pane: {
              workspace_id: 'child',
              tab_id: 'tab',
              pane_id: 'pane',
              terminal_id: 'terminal',
              cwd: '/fixture/worktree',
            },
          },
        });
      },
    },
  });
  const result = await provider.attachWorker!({
    target,
    server,
    root: '/fixture/worktree',
    workspaceId: 'child',
    label: 'worker',
    environment: { APP_PORT: '31000', DB_PORT: '31001' },
  });

  assert.ok(result.outcome === 'completed');
  assert.deepEqual(result.value.handle, {
    workspaceId: 'child',
    tabId: 'tab',
    paneId: 'pane',
    terminalId: 'terminal',
  });
  assert.deepEqual(requests[0]?.args, [
    'tab',
    'create',
    '--workspace',
    'child',
    '--cwd',
    '/fixture/worktree',
    '--label',
    'worker',
    '--env',
    'APP_PORT=31000',
    '--env',
    'DB_PORT=31001',
    '--no-focus',
  ]);
});

await test(
  'a worker space binds the port-configured pane in its grouped workspace',
  options,
  async () => {
    await fixture(async ({ configure, deps, fake, worker, opened, state }) => {
      await configure();
      const path = join(state, 'config', 'project-0.json');
      const policy = JSON.parse(await readFile(path, 'utf8')) as {
        execution: { agentSettings?: Record<string, unknown> };
      };
      policy.execution.agentSettings = {
        implementer: {
          provider: 'fixture',
          model: 'fixture-model',
          reasoning: 'high',
          ports: { APP_PORT: { fixed: 31019 } },
        },
      };
      await writeFile(path, JSON.stringify(policy));
      const job = await worker('port-worker');
      const ports = createAgentPorts({
        configuration: deps.configuration,
        allocations: opened.allocations,
      });

      const original = deps.provider.attachWorker?.bind(deps.provider);

      assert.ok(original);

      let environment: Record<string, string> | undefined;
      const provider = {
        ...deps.provider,
        async attachWorker(input: Parameters<typeof original>[0], signal?: AbortSignal) {
          environment = input.environment;
          const openedWorker = await original(input, signal);

          if (openedWorker.outcome !== 'completed') {
            return openedWorker;
          }

          const snapshot = fake.snapshot(input.target);
          const originalPane = snapshot.panes.find((item) => item.cwd === input.root);

          assert.ok(originalPane);

          const handle = {
            ...originalPane,
            tabId: 'configured-tab',
            paneId: 'configured-pane',
            terminalId: 'configured-terminal',
          };
          snapshot.tabs.push({ id: handle.tabId, workspaceId: handle.workspaceId });
          snapshot.panes.push(handle);

          return {
            schemaVersion: 1 as const,
            outcome: 'completed' as const,
            value: {
              handle: {
                workspaceId: handle.workspaceId,
                tabId: handle.tabId,
                paneId: handle.paneId,
                terminalId: handle.terminalId,
              },
            },
          };
        },
      };
      const prepared = space(
        await prepareHerdrWorker(
          { schemaVersion: 1, attemptId: job.attempt.id },
          { ...deps, provider, agentPorts: ports },
        ),
        'prepared',
      );

      assert.deepEqual(environment, { APP_PORT: '31019' });
      assert.equal(prepared.handle?.paneId, 'configured-pane');
      assert.notEqual(prepared.handle?.workspaceId, prepared.primaryWorkspaceId);
    });
  },
);
