import { persistedRunReconciliationSchema } from '../src/adapters/state/run-reconciliation-codec.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createCodexHerdrRuntime,
  createCodexRunShutdownVerifier,
  createServiceCoordinator,
  reconcileRun,
  cancelRun,
  openSqliteState,
  acquireCoordinatorOwnership,
  type RunView,
  type RunReconcileRequest,
} from '../src/index.js';
import { fixture } from './support/runtime.js';
const options = { timeout: 90000 };
type Context = Parameters<Parameters<typeof fixture>[0]>[0];
function run(context: Context, id: string): RunView {
  const result = context.context.opened.runs.inspect(id);

  assert.ok(result.outcome === 'completed' && result.value, JSON.stringify(result));

  return result.value;
}

async function prepare(context: Context) {
  const job = await context.prepare();
  const runtime = createCodexHerdrRuntime(context.deps);
  const observed = await runtime.start(job, new AbortController().signal);
  const stored = context.context.opened.service.observe(job.job.id, observed, Date.now());

  assert.equal(stored.outcome, 'persisted', JSON.stringify(stored));
  assert.equal(observed.state, 'running');

  const cancellation = await cancelRun(
    { schemaVersion: 1, jobId: job.job.id, key: 'stop' },
    {
      runs: context.context.opened.runs,
      workerControl: { interrupt: async () => assert.fail('No interrupt requested') },
    },
  );

  assert.equal(cancellation.outcome, 'persisted');

  const saved = context.deps.runtime.read(job.attempt.id);

  assert.ok(saved.outcome === 'completed' && saved.value?.space.handle);

  const session = saved.value;
  const request: RunReconcileRequest = {
    schemaVersion: 1,
    jobId: job.job.id,
    attemptId: job.attempt.id,
    launchId: session.launchId,
    key: 'shutdown',
    expectedRevision: run(context, job.job.id).control.revision,
    workerStopped: true,
    servicesStopped: true,
    writersStopped: true,
  };
  const deps = {
    runs: context.context.opened.runs,
    shutdown: createCodexRunShutdownVerifier({ ...context.deps, now: Date.now }),
  };
  function close() {
    const snapshot = context.context.fake.snapshot(session.space.target);
    const id = session.space.handle?.workspaceId;
    snapshot.agents = snapshot.agents.filter((a) => a.workspaceId !== id);
    snapshot.panes = snapshot.panes.filter((a) => a.workspaceId !== id);
    snapshot.tabs = snapshot.tabs.filter((a) => a.workspaceId !== id);
    snapshot.workspaces = snapshot.workspaces.filter((a) => a.id !== id);
  }

  return { job, session, request, deps, runtime, close };
}

await test(
  'shutdown reconciliation requires explicit host evidence and fresh provider absence; commit is scoped, durable and idempotent',
  options,
  async () => {
    await fixture(async (context) => {
      const setup = await prepare(context);
      const { request, deps, close, job } = setup;
      const before = run(context, job.job.id);

      assert.equal((await reconcileRun(request, deps)).outcome, 'rejected');
      assert.deepEqual(run(context, job.job.id), before);

      close();

      for (const change of [
        { workerStopped: false },
        { servicesStopped: false },
        { writersStopped: false },
        { launchId: 'other' },
        { attemptId: 'other' },
        { expectedRevision: 99 },
      ]) {
        assert.equal((await reconcileRun({ ...request, ...change }, deps)).outcome, 'rejected');
        assert.deepEqual(run(context, job.job.id), before);
      }

      const result = await reconcileRun(request, deps);

      assert.ok(result.outcome === 'persisted', JSON.stringify(result));
      assert.equal(result.value.status, 'cancelled');
      assert.equal(result.value.job.entry.observation?.state, 'quiescent');
      assert.equal(result.value.cleanup.state, 'reconciled');
      assert.equal(result.value.cleanup.retainedResourceCount, 0);

      const legacy = persistedRunReconciliationSchema.parse({
        request,
        source: 'host-attestation',
        session: setup.session,
        verifiedAt: result.value.cleanup.reconciliation?.verifiedAt,
        providerEvidence: 'owned-workspace-and-agent-absent',
        releasedResourceIds: result.value.cleanup.reconciliation?.releasedResourceIds,
      });
      const resolved = context.context.opened.store.inspectRecord({
        schemaVersion: 1,
        entity: 'attempt',
        id: job.attempt.id,
      });

      assert.deepEqual(legacy, result.value.cleanup.reconciliation);
      assert.ok(
        resolved.outcome === 'completed' &&
          resolved.value?.entity === 'attempt' &&
          resolved.value.resolvedAt !== null,
      );

      assert.equal(result.value.cleanup.reconciliation?.source, 'host-attestation');
      assert.equal(result.value.cleanup.reconciliation?.releasedResourceIds.length, 4);
      assert.ok(result.value.cleanup.resources.every((r) => r.releasedAt !== null));
      assert.equal(result.value.job.job.checkoutId, before.job.job.checkoutId);
      assert.equal(context.calls.filter((c) => c.operation === 'launch').length, 1);

      const repeated = await reconcileRun(request, {
        ...deps,
        shutdown: { verify: async () => assert.fail('Retry must be offline') },
      });

      assert.ok(repeated.outcome === 'persisted' && repeated.disposition === 'existing');
      assert.equal((await reconcileRun({ ...request, key: 'changed' }, deps)).outcome, 'rejected');

      const reopened = await openSqliteState({
        schemaVersion: 1,
        stateDirectory: context.context.state,
        mode: 'read-only',
      });

      assert.ok(reopened.outcome === 'opened');

      try {
        assert.deepEqual(
          reopened.runs.inspect(job.job.id),
          context.context.opened.runs.inspect(job.job.id),
        );

        const events = reopened.runs.events({
          schemaVersion: 1,
          jobId: job.job.id,
          after: 0,
          limit: 100,
          waitMs: 0,
        });

        assert.ok(events.outcome === 'completed');
        assert.equal(
          events.value.events.filter((e) => e.kind === 'lifecycle_reconciled').length,
          1,
        );
      } finally {
        reopened.store.close();
      }
    });
  },
);
await test(
  'unavailable or replaced provider, pending input and unrecognized resources retain all holds',
  options,
  async () => {
    await fixture(async (context) => {
      const { request, deps, close, job, session } = await prepare(context);
      close();
      const before = run(context, job.job.id);
      context.context.fake.modes.unavailable = true;

      assert.equal((await reconcileRun(request, deps)).outcome, 'rejected');

      context.context.fake.modes.unavailable = false;
      const snapshot = context.context.fake.snapshot(session.space.target);
      const inode = snapshot.server.inode;
      snapshot.server.inode = '999';

      assert.equal((await reconcileRun(request, deps)).outcome, 'rejected');

      snapshot.server.inode = inode;
      const reserved = context.deps.runtime.reserveAction(session, {
        attemptId: job.attempt.id,
        key: 'uncertain',
        kind: 'input',
        digest: '1'.repeat(64),
        state: 'pending',
        generation: 0,
      });

      assert.equal(reserved.outcome, 'persisted');
      assert.equal((await reconcileRun(request, deps)).outcome, 'rejected');
      assert.deepEqual(run(context, job.job.id), before);

      const acknowledged = context.deps.runtime.acknowledge({
        attemptId: job.attempt.id,
        key: 'uncertain',
        kind: 'input',
        digest: '1'.repeat(64),
        state: 'pending',
        generation: 0,
      });

      assert.equal(acknowledged.outcome, 'persisted');

      const resource = context.context.opened.store.retainResource({
        schemaVersion: 1,
        resource: {
          id: 'unknown-service',
          attemptId: job.attempt.id,
          kind: 'custom-service',
          key: 'shared',
          createdAt: 1,
          handle: {},
        },
      });

      assert.equal(resource.outcome, 'persisted');
      assert.equal((await reconcileRun(request, deps)).outcome, 'rejected');
      assert.equal(
        run(context, job.job.id).cleanup.resources.some((r) => r.releasedAt !== null),
        false,
      );
      assert.equal(run(context, job.job.id).cleanup.state, 'retained');
    });
  },
);
await test(
  'capacity one admits the next queued job after reconciliation and does not relaunch the stopped attempt after restart',
  options,
  async () => {
    await fixture(async (context) => {
      const { job, request, deps, runtime, close } = await prepare(context);
      const second = await context.context.worker('second');
      function coordinator() {
        return createServiceCoordinator({
          sessionId: 'reconciliation-fixture',
          dependencies: {
            ...context.deps,
            now: Date.now,
            nextId: (kind) => `${kind}-reconcile-${Math.random().toString(16).slice(2)}`,
          },
          runtimes: [runtime],
          limits: { global: 1, defaultRole: 1, perRole: {} },
          onFailure: () => assert.fail('Coordinator failed'),
        });
      }

      const first = coordinator();
      first.start();
      await first.idle();
      await first.stop();

      assert.equal(context.calls.filter((c) => c.operation === 'launch').length, 1);
      assert.equal(run(context, second.job.id).job.entry.claim, null);

      close();
      const result = await reconcileRun(request, deps);

      assert.equal(result.outcome, 'persisted', JSON.stringify(result));

      const restarted = coordinator();
      restarted.start();
      await restarted.idle();
      await restarted.stop();

      assert.equal(run(context, second.job.id).job.entry.state, 'started');
      assert.equal(context.calls.filter((c) => c.operation === 'launch').length, 2);
      assert.equal(run(context, job.job.id).cleanup.state, 'reconciled');
    });
  },
);
await test(
  'offline CLI refuses reconciliation while another coordinator owns state, before invoking providers',
  options,
  async () => {
    await fixture(async (context) => {
      const { request } = await prepare(context);
      const lock = await acquireCoordinatorOwnership(context.context.state);

      try {
        const cli = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('../dist/cli/main.js', import.meta.url)),
            '--state-directory',
            context.context.state,
            'run',
            'reconcile',
            request.jobId,
            '--key',
            request.key,
            '--attempt',
            request.attemptId,
            '--launch',
            request.launchId,
            '--revision',
            String(request.expectedRevision),
            '--worker-stopped',
            '--services-stopped',
            '--writers-stopped',
            '--json',
          ],
          { encoding: 'utf8' },
        );
        const response = JSON.parse(cli.stdout) as { error: { code: string } };

        assert.equal(cli.status, 1);
        assert.equal(response.error.code, 'service_already_running');
        assert.equal(run(context, request.jobId).cleanup.state, 'retained');
      } finally {
        lock.release();
      }
    });
  },
);
