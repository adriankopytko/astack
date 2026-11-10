import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  createServiceCoordinator,
  startLocalService,
  requestLocalService,
  acquireCoordinatorOwnership,
  submitServiceJob,
  checkConfigurationDispatch,
  openSqliteState,
  serviceJobSchema,
  type ServiceWorkerRuntime,
  type ServiceJob,
  type WorkerObservation,
} from '../src/index.js';
import { fixture, git, gitPath, writeProjectConfiguration } from './support/service.js';
import { createAgentHooks } from '../src/host/agent-hooks.js';
import { createAgentPorts } from '../src/application/agent-ports.js';

const compiled = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const childFixture = fileURLToPath(new URL('./fixtures/service-child.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const options = { timeout: 90_000 };

await test(
  'agent before and after scripts run once from the saved job configuration',
  options,
  async () => {
    await fixture(async ({ deps, request, opened, state, root }) => {
      const marker = join(root, 'hooks-output');
      const path = join(state, 'config', 'project-0.json');
      const policy = JSON.parse(await readFile(path, 'utf8')) as {
        execution: { agentSettings?: Record<string, unknown> };
      };
      policy.execution.agentSettings = {
        implementer: {
          provider: 'fixture',
          model: 'fixture-model',
          reasoning: 'high',
          hooks: {
            before: `printf before >> ${JSON.stringify(marker)}`,
            after: `printf after >> ${JSON.stringify(marker)}`,
          },
        },
      };
      await writeFile(path, JSON.stringify(policy));
      const submitted = await submitServiceJob(request(0, 'agent-hooks'), deps);

      assert.equal(submitted.outcome, 'persisted');

      if (submitted.outcome !== 'persisted') {
        assert.fail(JSON.stringify(submitted));
      }

      policy.execution.agentSettings = {
        implementer: {
          provider: 'fixture',
          model: 'fixture-model',
          reasoning: 'high',
          hooks: { before: 'exit 4', after: 'exit 4' },
        },
      };
      await writeFile(path, JSON.stringify(policy));

      const hooks = createAgentHooks({ ...deps, state: opened.store });
      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'agent-hook-test',
        dependencies: { ...deps, agentHooks: hooks },
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('coordinator failed'),
      });
      coordinator.start();
      await coordinator.idle();

      assert.deepEqual(worker.started, [submitted.value.job.id]);
      assert.equal(await readFile(marker, 'utf8'), 'before');
      assert.equal(
        (await hooks.run(submitted.value, 'before', new AbortController().signal)).outcome,
        'completed',
      );
      assert.equal(
        (await hooks.run(submitted.value, 'after', new AbortController().signal)).outcome,
        'completed',
      );
      assert.equal(
        (await hooks.run(submitted.value, 'after', new AbortController().signal)).outcome,
        'completed',
      );
      assert.equal(await readFile(marker, 'utf8'), 'beforeafter');

      await coordinator.stop();
    });
  },
);

await test(
  'a failing before hook blocks worker launch and records the failure',
  options,
  async () => {
    await fixture(async ({ deps, request, opened, state }) => {
      const path = join(state, 'config', 'project-0.json');
      const policy = JSON.parse(await readFile(path, 'utf8')) as {
        execution: { agentSettings?: Record<string, unknown> };
      };
      policy.execution.agentSettings = {
        implementer: {
          provider: 'fixture',
          model: 'fixture-model',
          reasoning: 'high',
          hooks: { before: 'exit 7' },
        },
      };
      await writeFile(path, JSON.stringify(policy));
      const submitted = await submitServiceJob(request(0, 'failing-hook'), deps);

      assert.ok(submitted.outcome === 'persisted');

      const hooks = createAgentHooks({ ...deps, state: opened.store });
      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'failing-hook-test',
        dependencies: { ...deps, agentHooks: hooks },
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('coordinator failed'),
      });
      coordinator.start();
      await coordinator.idle();

      assert.deepEqual(worker.started, []);

      const job = saved(opened.service.read(submitted.value.job.id));

      assert.equal(job.entry.state, 'blocked');
      assert.equal(job.entry.readiness?.code, 'hook_blocked');

      const run = opened.runs.inspect(job.job.id);

      assert.ok(run.outcome === 'completed' && run.value);
      assert.equal(
        run.value.cleanup.resources.find((item) => item.kind === 'agent-hook-before')?.hookOutcome,
        'failed',
      );

      await coordinator.stop();
    });
  },
);

await test(
  'a before script can start a background process that its after script stops',
  options,
  async () => {
    await fixture(async ({ deps, request, opened, state, root }) => {
      const pidFile = join(root, 'background.pid');
      const path = join(state, 'config', 'project-0.json');
      const policy = JSON.parse(await readFile(path, 'utf8')) as {
        execution: { agentSettings?: Record<string, unknown> };
      };
      policy.execution.agentSettings = {
        implementer: {
          provider: 'fixture',
          model: 'fixture-model',
          reasoning: 'high',
          hooks: {
            before: `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)' & echo $! > ${JSON.stringify(pidFile)}`,
            after: `kill "$(cat ${JSON.stringify(pidFile)})"`,
          },
        },
      };
      await writeFile(path, JSON.stringify(policy));
      const submitted = await submitServiceJob(request(0, 'background-hook'), deps);

      assert.ok(submitted.outcome === 'persisted');

      const hooks = createAgentHooks({ ...deps, state: opened.store });
      let pid: number | undefined;

      try {
        assert.equal(
          (await hooks.run(submitted.value, 'before', new AbortController().signal)).outcome,
          'completed',
        );

        pid = Number(await readFile(pidFile, 'utf8'));

        assert.ok(Number.isInteger(pid) && pid > 1);
        assert.doesNotThrow(() => process.kill(pid!, 0));
        assert.equal(
          (await hooks.run(submitted.value, 'after', new AbortController().signal)).outcome,
          'completed',
        );
      } finally {
        if (pid) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }
      }
    });
  },
);

await test('a timed-out before hook blocks the worker and is not run again', options, async () => {
  await fixture(async ({ deps, request, opened, state, root }) => {
    const path = join(state, 'config', 'project-0.json');
    const marker = join(root, 'timed-hook');
    const policy = JSON.parse(await readFile(path, 'utf8')) as {
      execution: { agentSettings?: Record<string, unknown> };
    };
    policy.execution.agentSettings = {
      implementer: {
        provider: 'fixture',
        model: 'fixture-model',
        reasoning: 'high',
        hooks: { before: `printf run >> ${JSON.stringify(marker)}; sleep 10` },
        hookTimeouts: { before: 1000 },
      },
    };
    await writeFile(path, JSON.stringify(policy));
    const submitted = await submitServiceJob(request(0, 'timed-hook'), deps);

    assert.ok(submitted.outcome === 'persisted');

    const hooks = createAgentHooks({ ...deps, state: opened.store });
    const worker = provider();
    const coordinator = createServiceCoordinator({
      sessionId: 'timed-hook-test',
      dependencies: { ...deps, agentHooks: hooks },
      limits: { global: 1, defaultRole: 1, perRole: {} },
      runtimes: [worker.runtime],
      onFailure: () => assert.fail('coordinator failed'),
    });
    coordinator.start();
    await coordinator.idle();
    coordinator.wake();
    await coordinator.idle();

    assert.deepEqual(worker.started, []);
    assert.equal(await readFile(marker, 'utf8'), 'run');

    const run = opened.runs.inspect(submitted.value.job.id);

    assert.ok(run.outcome === 'completed' && run.value);
    assert.equal(
      run.value.cleanup.resources.find((item) => item.kind === 'agent-hook-before')?.hookOutcome,
      'unknown',
    );

    await coordinator.stop();
  });
});

function saved(
  result: ReturnType<import('../src/ports/service.js').ServiceStore['read']>,
): ServiceJob {
  assert.equal(result.outcome, 'completed');

  if (result.outcome !== 'completed' || !result.value) {
    assert.fail(JSON.stringify(result));
  }

  return serviceJobSchema.parse(result.value);
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for controlled service evidence');

    await delay(30);
  }
}

function provider() {
  const started: string[] = [];
  const observations = new Map<string, WorkerObservation>();
  const runtime: ServiceWorkerRuntime = {
    id: 'fixture',
    async start(job) {
      started.push(job.job.id);
      const observation: WorkerObservation = {
        state: 'running',
        handle: { id: job.attempt.id },
        evidence: { fixture: true },
      };
      observations.set(job.job.id, observation);

      return observation;
    },
    async inspect(job) {
      return (
        observations.get(job.job.id) ?? {
          state: 'unknown',
          handle: null,
          evidence: { fixture: true },
        }
      );
    },
  };

  return { runtime, started, observations };
}

await test(
  'service submission atomically persists one job, attempt, pending effect and queue entry',
  options,
  async () => {
    await fixture(async ({ deps, request, opened }) => {
      const input = request(0, 'stable');
      const results = await Promise.all([
        submitServiceJob(input, deps),
        submitServiceJob(input, deps),
      ]);

      assert.ok(results.every((result) => result.outcome === 'persisted'));

      const ids = results.map((result) =>
        result.outcome === 'persisted' ? result.value.job.id : 'invalid',
      );

      assert.equal(new Set(ids).size, 1);

      const current = saved(opened.service.read(ids[0] ?? ''));

      assert.equal(current.entry.state, 'queued');
      assert.equal(current.effect.state, 'pending');
      assert.equal(current.effect.claim, null);
      assert.equal(current.attempt.number, 1);

      const conflict = await submitServiceJob({ ...input, commit: 'a'.repeat(40) }, deps);

      assert.equal(conflict.outcome === 'rejected' && conflict.error.code, 'state_conflict');

      const before = opened.service.list();
      const invalid = await submitServiceJob({ ...input, schemaVersion: 2 }, deps);

      assert.equal(
        invalid.outcome === 'rejected' && invalid.error.code,
        'unsupported_contract_version',
      );
      assert.deepEqual(opened.service.list(), before);
    });
  },
);

await test(
  'new jobs read updated configuration while queued jobs retain their saved settings',
  options,
  async () => {
    await fixture(async ({ deps, request, opened, state }) => {
      const first = await submitServiceJob(request(0, 'before-edit'), deps);

      assert.ok(first.outcome === 'persisted');

      const path = join(state, 'config', 'project-0.json');
      const policy = JSON.parse(await readFile(path, 'utf8')) as {
        execution: { commands: Record<string, { executable: string; args: string[] }> };
      };
      policy.execution.commands['fixture-worker']!.args = ['--help'];
      await writeFile(path, JSON.stringify(policy));
      const retry = await submitServiceJob(request(0, 'before-edit'), deps);

      assert.ok(retry.outcome === 'persisted' && retry.disposition === 'existing');
      assert.equal(retry.value.job.id, first.value.job.id);

      const cancelled = await submitServiceJob(
        request(0, 'before-edit'),
        deps,
        AbortSignal.abort(),
      );

      assert.ok(cancelled.outcome === 'rejected' && cancelled.error.code === 'cancelled');

      const second = await submitServiceJob(request(0, 'after-edit'), deps);

      assert.ok(second.outcome === 'persisted');
      assert.notEqual(
        first.value.job.configuration?.policyDigest,
        second.value.job.configuration?.policyDigest,
      );
      assert.equal(JSON.stringify(first.value).includes('--version'), false);
      assert.equal(JSON.stringify(second.value).includes('--help'), false);

      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: state,
        mode: 'read-only',
      });

      assert.ok(reopened.outcome === 'opened');

      try {
        const stored = reopened.store.readJobConfiguration(first.value.job.id);

        assert.ok(stored.outcome === 'completed' && stored.value);
        assert.deepEqual(
          (stored.value as { execution: { commands: Record<string, { args: string[] }> } })
            .execution.commands['fixture-worker']?.args,
          ['--version'],
        );
      } finally {
        reopened.store.close();
      }

      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'config-test',
        dependencies: deps,
        limits: { global: 2, defaultRole: 2, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('Unexpected coordinator failure'),
      });
      coordinator.start();
      await coordinator.idle();
      await coordinator.stop();

      assert.ok(worker.started.includes(first.value.job.id));

      const secondReady = await checkConfigurationDispatch(
        { schemaVersion: 1, job: second.value.job },
        deps,
      );

      assert.ok(secondReady.outcome === 'completed' && secondReady.value.status === 'ready');
      assert.equal(opened.store.readJobConfiguration(first.value.job.id).outcome, 'completed');
    });
  },
);

await test('custom worker roles receive their own accepted configuration', options, async () => {
  await fixture(async ({ deps, request, state }) => {
    const path = join(state, 'config', 'project-0.json');
    const policy = JSON.parse(await readFile(path, 'utf8')) as {
      project: { roles: Record<string, { runtime: string; command: string }> };
    };
    policy.project.roles.researcher = { runtime: 'fixture', command: 'fixture-worker' };
    await writeFile(path, JSON.stringify(policy));
    const submitted = await submitServiceJob(request(0, 'research-task', 'researcher'), deps);

    assert.ok(submitted.outcome === 'persisted', JSON.stringify(submitted));
    assert.equal(submitted.value.job.configuration?.role, 'researcher');
    assert.equal(submitted.value.job.configuration?.effective.roles.researcher?.runtime, 'fixture');
  });
});

await test(
  'missing saved job configuration never falls back to current project settings',
  options,
  async () => {
    await fixture(async ({ deps, request, opened, state }) => {
      const submitted = await submitServiceJob(request(0, 'missing-snapshot'), deps);

      assert.ok(submitted.outcome === 'persisted');

      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(join(state, 'state.sqlite'));
      database.prepare('DELETE FROM job_configurations WHERE job_id=?').run(submitted.value.job.id);
      database.close();
      const check = await checkConfigurationDispatch(
        { schemaVersion: 1, job: submitted.value.job },
        deps,
      );

      assert.ok(check.outcome === 'completed' && check.value.status === 'blocked');
      assert.ok(check.value.diagnostics.some((item) => item.code === 'snapshot_missing'));
      assert.equal(opened.service.read(submitted.value.job.id).outcome, 'completed');
    });
  },
);

await test(
  'global and per-role capacity queue jobs; quiescence releases capacity without claiming task success',
  options,
  async () => {
    await fixture(async ({ submit, deps, opened }) => {
      const first = await submit(0, 'review-1', 'reviewer');
      const second = await submit(1, 'review-2', 'reviewer');
      const third = await submit(2, 'implementation');
      const worker = provider();
      let notify = () => {};

      worker.runtime.subscribe = (wake) => {
        notify = wake;

        return () => {};
      };

      const coordinator = createServiceCoordinator({
        sessionId: 'fixture-session',
        dependencies: deps,
        limits: { global: 2, defaultRole: 1, perRole: { reviewer: 1 } },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('Unexpected coordinator failure'),
      });

      try {
        coordinator.start();
        await coordinator.idle();

        assert.deepEqual(worker.started, [first.job.id, third.job.id]);
        assert.equal(saved(opened.service.read(second.job.id)).entry.state, 'queued');

        worker.observations.set(first.job.id, {
          state: 'quiescent',
          handle: { id: first.attempt.id },
          evidence: { writerAndChildrenStopped: true },
        });
        notify();
        await coordinator.idle();

        assert.deepEqual(worker.started, [first.job.id, third.job.id, second.job.id]);
        assert.equal(saved(opened.service.read(first.job.id)).entry.state, 'awaiting_result');

        const attempt = opened.store.inspectRecord({
          schemaVersion: 1,
          entity: 'attempt',
          id: first.attempt.id,
        });

        assert.equal(
          attempt.outcome === 'completed' &&
            attempt.value?.entity === 'attempt' &&
            attempt.value.resolvedAt,
          null,
        );
      } finally {
        await coordinator.stop();
      }
    });
  },
);

await test(
  'uncertain launches retain capacity after claim expiry and restart without another writer',
  options,
  async () => {
    await fixture(async ({ submit, deps, opened, advance }) => {
      const first = await submit(0, 'uncertain');
      const second = await submit(1, 'waiting');
      let launches = 0;
      const runtime: ServiceWorkerRuntime = {
        id: 'fixture',
        async start() {
          launches++;

          throw new Error('fixture-private-error');
        },
        async inspect() {
          return { state: 'unknown', handle: null, evidence: { uncertain: true } };
        },
      };
      const make = (sessionId: string) =>
        createServiceCoordinator({
          sessionId,
          dependencies: deps,
          limits: { global: 1, defaultRole: 1, perRole: {} },
          runtimes: [runtime],
          onFailure: () => assert.fail('Unexpected state failure'),
        });
      const original = make('first-session');
      original.start();
      await original.idle();
      await original.stop();
      advance();
      const restarted = make('second-session');

      try {
        restarted.start();
        await restarted.idle();

        assert.equal(launches, 1);
        assert.equal(saved(opened.service.read(first.job.id)).entry.state, 'unknown');
        assert.equal(saved(opened.service.read(second.job.id)).entry.state, 'queued');
        assert.equal(
          JSON.stringify(opened.service.read(first.job.id)).includes('fixture-private-error'),
          false,
        );
      } finally {
        await restarted.stop();
      }
    });
  },
);

await test('verified unstarted launches are blocked without implicit retry', options, async () => {
  await fixture(async ({ submit, deps, opened }) => {
    const job = await submit(0, 'refused');
    let calls = 0;
    const runtime: ServiceWorkerRuntime = {
      id: 'fixture',
      async start() {
        calls++;

        return { state: 'not_started', handle: null, evidence: { refusedBeforeEffects: true } };
      },
      async inspect() {
        assert.fail('Refused launches must not be inspected as live');
      },
    };
    const coordinator = createServiceCoordinator({
      sessionId: 'refusal-session',
      dependencies: deps,
      limits: { global: 1, defaultRole: 1, perRole: {} },
      runtimes: [runtime],
      onFailure: () => assert.fail('Unexpected failure'),
    });

    try {
      coordinator.start();
      await coordinator.idle();
      coordinator.wake();
      await coordinator.idle();

      assert.equal(calls, 1);
      assert.equal(saved(opened.service.read(job.job.id)).entry.reason, 'provider_refused');
      assert.equal(saved(opened.service.read(job.job.id)).effect.state, 'cancelled');
    } finally {
      await coordinator.stop();
    }
  });
});

await test(
  'uncertain capacity commit stops dispatch before any runtime call',
  options,
  async () => {
    await fixture(async ({ submit, deps, opened }) => {
      const job = await submit(0, 'uncertain-commit');
      const worker = provider();
      let failed = false;
      const coordinator = createServiceCoordinator({
        sessionId: 'uncertain-session',
        dependencies: {
          ...deps,
          queue: {
            ...deps.queue,
            claim(input) {
              const result = deps.queue.claim(input);

              assert.equal(result.outcome, 'persisted');

              return {
                schemaVersion: 1,
                outcome: 'uncertain',
                error: { code: 'state_write_uncertain', message: 'fixture lost acknowledgment' },
              };
            },
          },
        },
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => {
          failed = true;
        },
      });

      try {
        coordinator.start();
        await coordinator.idle();

        assert.equal(failed, true);
        assert.equal(worker.started.length, 0);
        assert.equal(saved(opened.service.read(job.job.id)).entry.state, 'dispatching');
      } finally {
        await coordinator.stop();
      }
    });
  },
);

await test(
  'shutdown drains an abort-aware launch and retains unknown evidence',
  options,
  async () => {
    await fixture(async ({ submit, deps, opened }) => {
      const job = await submit(0, 'shutdown');
      let launching = false;
      let drained = false;
      const runtime: ServiceWorkerRuntime = {
        id: 'fixture',
        async start(_job, signal) {
          launching = true;
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          drained = true;

          return { state: 'unknown', handle: null, evidence: { launchInterrupted: true } };
        },
        async inspect() {
          return { state: 'unknown', handle: null, evidence: {} };
        },
      };
      const coordinator = createServiceCoordinator({
        sessionId: 'shutdown-session',
        dependencies: deps,
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [runtime],
        onFailure: () => assert.fail('Unexpected failure'),
      });
      coordinator.start();
      await until(async () => launching);
      await coordinator.stop();

      assert.equal(drained, true);
      assert.equal(saved(opened.service.read(job.job.id)).entry.state, 'unknown');
    });
  },
);

await test(
  'changed checkout assignment and absent runtimes block while accepted settings survive edits',
  options,
  async () => {
    await fixture(async ({ submit, deps, state, sources, opened }) => {
      const first = await submit(0, 'policy');
      const second = await submit(1, 'assignment');
      const third = await submit(2, 'runtime');
      const path = join(state, 'config/project-0.json');
      const policy = JSON.parse(await readFile(path, 'utf8')) as {
        execution: { commands: Record<string, { executable: string; args: string[] }> };
      };
      policy.execution.commands['fixture-worker']!.args = ['--help'];
      await writeFile(path, JSON.stringify(policy));
      git(sources[1] ?? '', 'commit', '--allow-empty', '-m', 'changed');
      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'validation-session',
        dependencies: deps,
        limits: { global: 3, defaultRole: 3, perRole: {} },
        runtimes: [],
        onFailure: () => assert.fail('Unexpected failure'),
      });

      try {
        coordinator.start();
        await coordinator.idle();

        assert.equal(saved(opened.service.read(first.job.id)).entry.reason, 'runtime_unavailable');
        assert.equal(saved(opened.service.read(second.job.id)).entry.reason, 'runtime_unavailable');
        assert.equal(saved(opened.service.read(third.job.id)).entry.reason, 'runtime_unavailable');
        assert.equal(worker.started.length, 0);

        const errors = opened.errors.list(20);

        assert.ok(errors.outcome === 'completed');
        assert.ok(
          errors.value.some(
            (error) => error.jobId === third.job.id && error.code === 'runtime_unavailable',
          ),
        );
      } finally {
        await coordinator.stop();
      }

      const withRuntime = createServiceCoordinator({
        sessionId: 'assignment-session',
        dependencies: deps,
        limits: { global: 3, defaultRole: 3, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('Unexpected failure'),
      });

      try {
        withRuntime.start();
        await withRuntime.idle();

        assert.equal(saved(opened.service.read(second.job.id)).entry.reason, 'assignment_changed');
        assert.deepEqual(new Set(worker.started), new Set([first.job.id, third.job.id]));
      } finally {
        await withRuntime.stop();
      }
    });
  },
);

await test(
  'same checkout jobs serialize even when global capacity permits more workers',
  options,
  async () => {
    await fixture(async ({ submit, deps, opened }) => {
      const first = await submit(0, 'first');
      const second = await submit(0, 'second', 'reviewer');
      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'checkout-session',
        dependencies: deps,
        limits: { global: 3, defaultRole: 3, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('Unexpected failure'),
      });

      try {
        coordinator.start();
        await coordinator.idle();

        assert.deepEqual(worker.started, [first.job.id]);
        assert.equal(saved(opened.service.read(second.job.id)).entry.state, 'queued');
      } finally {
        await coordinator.stop();
      }
    });
  },
);

await test(
  'kernel-backed ownership excludes competitors and releases without stealing a lease',
  options,
  async () => {
    await fixture(async ({ state }) => {
      const first = await acquireCoordinatorOwnership(state);

      try {
        await assert.rejects(
          acquireCoordinatorOwnership(state),
          (error: unknown) =>
            error instanceof Error && 'code' in error && error.code === 'service_already_running',
        );
      } finally {
        first.release();
      }

      const next = await acquireCoordinatorOwnership(state);
      next.release();

      assert.equal((await lstat(join(state, 'coordinator.sqlite'))).mode & 0o077, 0);
    });
  },
);

await test(
  'socket lifecycle survives client disconnect and preserves accepted jobs; unowned endpoints are refused',
  options,
  async () => {
    await fixture(async ({ state, request, opened, sources }) => {
      await writeProjectConfiguration({ state, sources }, 0);
      const service = await startLocalService({
        schemaVersion: 1,
        stateDirectory: state,
        gitExecutable: gitPath,
      });

      if (service.outcome !== 'listening') {
        assert.fail(JSON.stringify(service));
      }

      try {
        const duplicate = await startLocalService({
          schemaVersion: 1,
          stateDirectory: state,
          gitExecutable: gitPath,
        });

        assert.equal(
          duplicate.outcome === 'rejected' && duplicate.error.code,
          'service_already_running',
        );
        assert.equal((await lstat(service.socketPath)).mode & 0o077, 0);

        const socket = createConnection(service.socketPath);
        await once(socket, 'connect');
        socket.write(`${JSON.stringify({ ...request(0, 'disconnect'), operation: 'submit' })}\n`);
        await delay(30);
        socket.destroy();
        await until(async () => {
          const page = opened.service.list();

          return page.outcome === 'completed' && page.value.items.length === 1;
        });
        const repeated = await requestLocalService(state, {
          ...request(0, 'disconnect'),
          operation: 'submit',
        });

        assert.equal(repeated.outcome === 'persisted' && repeated.disposition, 'existing');

        const invalid = await requestLocalService(state, { schemaVersion: 2, operation: 'status' });

        assert.equal(
          invalid.outcome === 'rejected' && invalid.error.code,
          'unsupported_contract_version',
        );
      } finally {
        await service.close();
      }

      assert.equal(opened.service.list().outcome, 'completed');

      await writeFile(join(state, 'service.sock'), 'authored file');
      const refused = await startLocalService({
        schemaVersion: 1,
        stateDirectory: state,
        gitExecutable: gitPath,
      });

      assert.equal(refused.outcome, 'rejected');
      assert.equal(await readFile(join(state, 'service.sock'), 'utf8'), 'authored file');
    });
  },
);

for (const mode of ['crash-before', 'crash-after'] as const) {
  await test(
    `real coordinator ${mode} retains effect intent and restarts without duplicate execution`,
    options,
    async () => {
      await fixture(async ({ state, request, opened, sources }) => {
        await writeProjectConfiguration({ state, sources }, 0);
        const child = spawn(process.execPath, [childFixture, compiled, state, gitPath, mode], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {},
        });
        const exited = once(child, 'exit');
        let output = '';
        let errors = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.toString();
        });

        try {
          await until(async () => output.includes('\n') || child.exitCode !== null);

          assert.match(output, /listening/, errors);

          const accepted = await requestLocalService(state, {
            ...request(0, mode),
            operation: 'submit',
          });

          assert.equal(accepted.outcome, 'persisted');

          await until(async () => child.exitCode !== null);
          const exitArguments: unknown = await exited;

          assert.ok(Array.isArray(exitArguments));
          assert.equal(exitArguments[0], mode === 'crash-before' ? 72 : 71, errors);

          const page = opened.service.list();

          assert.equal(page.outcome, 'completed');

          if (page.outcome !== 'completed' || !page.value.items[0]) {
            assert.fail('Missing durable effect');
          }

          const job = page.value.items[0];

          assert.equal(job.entry.state, 'dispatching');
          assert.ok(job.entry.claim);

          const worker = provider();
          worker.runtime.inspect = async (entry) =>
            mode === 'crash-after'
              ? {
                  state: 'running',
                  handle: { id: entry.attempt.id },
                  evidence: { fixtureArtifactConfirmed: true },
                }
              : { state: 'unknown', handle: null, evidence: { absenceIsNotProof: true } };
          const restarted = await startLocalService(
            { schemaVersion: 1, stateDirectory: state, gitExecutable: gitPath },
            { runtimes: [worker.runtime] },
          );

          if (restarted.outcome !== 'listening') {
            assert.fail(JSON.stringify(restarted));
          }

          try {
            await until(
              async () => saved(opened.service.read(job.job.id)).entry.state !== 'dispatching',
            );

            assert.equal(
              saved(opened.service.read(job.job.id)).entry.state,
              mode === 'crash-after' ? 'started' : 'unknown',
            );
            assert.equal(worker.started.length, 0);
            assert.equal(
              (await readdir(state)).filter((file) => file.startsWith('fixture-effect-')).length,
              mode === 'crash-after' ? 1 : 0,
            );
          } finally {
            await restarted.close();
          }
        } finally {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }

          await exited;
        }
      });
    },
  );
}

await test(
  'compiled CLI owns foreground lifecycle and status from a neutral directory',
  options,
  async () => {
    await fixture(async ({ state, root }) => {
      const child = spawn(
        process.execPath,
        [cli, '--state-directory', state, '--git-executable', gitPath, 'service', 'run', '--json'],
        { cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exited = once(child, 'exit');
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      try {
        await until(async () => output.includes('\n') || child.exitCode !== null);

        assert.match(output, /listening/);

        const result = spawnSync(
          process.execPath,
          [cli, '--state-directory', state, 'service', 'status', '--json'],
          { cwd: root, env: {}, encoding: 'utf8', timeout: 10_000 },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /"runtimes":\[\]/);

        child.kill('SIGTERM');
        await exited;

        assert.equal(child.exitCode, 0);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }

        await exited;
      }
    });
  },
);

await test(
  'host explicitly installs codex-herdr without starting a provider for an empty queue',
  options,
  async () => {
    await fixture(async ({ state }) => {
      // Executable fixtures are never invoked: an empty queue must not query Herdr or launch Codex.
      const service = await startLocalService(
        { schemaVersion: 1, stateDirectory: state, gitExecutable: gitPath },
        { codexHerdr: { herdrExecutable: process.execPath, codexExecutable: process.execPath } },
      );

      assert.equal(service.outcome, 'listening', JSON.stringify(service));

      if (service.outcome !== 'listening') {
        assert.fail('Missing fixture service');
      }

      try {
        const status = service.status();

        assert.ok(status.outcome === 'completed');
        assert.deepEqual(status.value.runtimes, ['codex-herdr', 'codex']);
      } finally {
        assert.equal((await service.close()).outcome, 'completed');
      }
    });
  },
);

await test(
  'a queued worker does not run its before hook while capacity is full',
  options,
  async () => {
    await fixture(async ({ deps, request, opened, state, root }) => {
      const markers = [join(root, 'first-hook'), join(root, 'second-hook')];

      for (const index of [0, 1]) {
        const path = join(state, 'config', `project-${index}.json`);
        const policy = JSON.parse(await readFile(path, 'utf8')) as {
          execution: { agentSettings?: Record<string, unknown> };
        };
        policy.execution.agentSettings = {
          implementer: {
            provider: 'fixture',
            model: 'fixture-model',
            reasoning: 'high',
            hooks: { before: `printf started > ${JSON.stringify(markers[index])}` },
          },
        };
        await writeFile(path, JSON.stringify(policy));
        const submission = await submitServiceJob(request(index, `capacity-${index}`), deps);

        assert.equal(submission.outcome, 'persisted');
      }

      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'hook-capacity-test',
        dependencies: { ...deps, agentHooks: createAgentHooks({ ...deps, state: opened.store }) },
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('coordinator failed'),
      });
      coordinator.start();
      await coordinator.idle();

      assert.equal(worker.started.length, 1);
      assert.equal(await readFile(markers[0]!, 'utf8'), 'started');

      await assert.rejects(readFile(markers[1]!, 'utf8'), { code: 'ENOENT' });
      await coordinator.stop();
    });
  },
);

await test(
  'configured ports are unique across projects and reach before scripts',
  options,
  async () => {
    await fixture(async ({ deps, request, opened, state, root }) => {
      const markers = [join(root, 'first-port'), join(root, 'second-port')];

      for (const index of [0, 1]) {
        const path = join(state, 'config', `project-${index}.json`);
        const policy = JSON.parse(await readFile(path, 'utf8')) as {
          execution: { agentSettings?: Record<string, unknown> };
        };
        policy.execution.agentSettings = {
          implementer: {
            provider: 'fixture',
            model: 'fixture-model',
            reasoning: 'high',
            ports: { APP_PORT: { range: [31000, 31001] } },
            hooks: { before: `printf '%s' "$APP_PORT" > ${JSON.stringify(markers[index])}` },
          },
        };
        await writeFile(path, JSON.stringify(policy));
        const submission = await submitServiceJob(request(index, `port-${index}`), deps);

        assert.equal(submission.outcome, 'persisted');
      }

      const ports = createAgentPorts({
        configuration: deps.configuration,
        allocations: opened.allocations,
      });
      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'port-hook-test',
        dependencies: {
          ...deps,
          agentHooks: createAgentHooks({ ...deps, state: opened.store, ports }),
        },
        limits: { global: 2, defaultRole: 2, perRole: {} },
        runtimes: [{ ...worker.runtime, supportsAgentPorts: true }],
        onFailure: () => assert.fail('coordinator failed'),
      });
      coordinator.start();
      await coordinator.idle();

      assert.equal(worker.started.length, 2);
      assert.deepEqual(
        [await readFile(markers[0]!, 'utf8'), await readFile(markers[1]!, 'utf8')].sort(),
        ['31000', '31001'],
      );

      await coordinator.stop();
    });
  },
);

await test('configured ports block runtimes that cannot inject them', options, async () => {
  await fixture(async ({ deps, request, opened, state }) => {
    const path = join(state, 'config', 'project-0.json');
    const policy = JSON.parse(await readFile(path, 'utf8')) as {
      execution: { agentSettings?: Record<string, unknown> };
    };
    policy.execution.agentSettings = {
      implementer: {
        provider: 'fixture',
        model: 'fixture-model',
        reasoning: 'high',
        ports: { APP_PORT: { fixed: 31005 } },
      },
    };
    await writeFile(path, JSON.stringify(policy));
    const submitted = await submitServiceJob(request(0, 'unsupported-ports'), deps);

    assert.ok(submitted.outcome === 'persisted');

    const worker = provider();
    const ports = createAgentPorts({
      configuration: deps.configuration,
      allocations: opened.allocations,
    });
    const coordinator = createServiceCoordinator({
      sessionId: 'unsupported-ports-test',
      dependencies: {
        ...deps,
        agentHooks: createAgentHooks({ ...deps, state: opened.store, ports }),
      },
      limits: { global: 1, defaultRole: 1, perRole: {} },
      runtimes: [worker.runtime],
      onFailure: () => assert.fail('coordinator failed'),
    });
    coordinator.start();
    await coordinator.idle();

    assert.deepEqual(worker.started, []);

    const blocked = saved(opened.service.read(submitted.value.job.id));

    assert.equal(blocked.entry.readiness?.code, 'resource_blocked');

    const allocations = opened.allocations.list({ projectId: 'project-0', after: '', limit: 10 });

    assert.ok(allocations.outcome === 'completed' && allocations.value.items.length === 0);

    await coordinator.stop();
  });
});

await test(
  'runtime observation callbacks run after the observation is persisted',
  options,
  async () => {
    await fixture(async ({ deps, request, opened }) => {
      const submitted = await submitServiceJob(request(0, 'observation-callback'), deps);

      assert.ok(submitted.outcome === 'persisted');

      const seen: string[] = [];
      const worker = provider();
      const coordinator = createServiceCoordinator({
        sessionId: 'observation-test',
        dependencies: deps,
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [worker.runtime],
        onFailure: () => assert.fail('coordinator failed'),
        onObservation(job, observation) {
          const saved = opened.service.read(job.job.id);

          assert.ok(saved.outcome === 'completed' && saved.value);
          assert.equal(saved.value.entry.observation?.state, observation.state);

          seen.push(observation.state);
        },
      });

      try {
        coordinator.start();
        await coordinator.idle();

        assert.ok(seen.includes('running'));
      } finally {
        await coordinator.stop();
      }
    });
  },
);
