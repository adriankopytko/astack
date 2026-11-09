import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueWorker } from '../src/application/enqueue-worker.js';
import { fixture } from './support/service.js';
import { fixture as herdrFixture } from './support/herdr.js';
import { git, writeProjectConfiguration } from './support/service.js';
import { startLocalService } from '../src/host/local-service.js';
import { requestLocalService } from '../src/adapters/local/service-client.js';
import { completed } from '../src/contracts/operation-result.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reconcileLocalQueuedWorker } from '../src/host/reconcile-run.js';

await test(
  'cancelling during preparation prevents the worker job from starting',
  { timeout: 60000 },
  async () => {
    await herdrFixture(async ({ configure, opened, fake, state, sources }) => {
      await configure();
      await writeProjectConfiguration({ state, sources }, 0);
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let starts = 0;
      const provider = {
        ...fake.provider,
        async createWorker(
          input: NonNullable<Parameters<NonNullable<typeof fake.provider.createWorker>>[0]>,
        ) {
          entered();
          await blocked;

          return fake.provider.createWorker!(input);
        },
      };
      const sha = git(sources[0]!, 'rev-parse', 'HEAD');
      const service = await startLocalService(
        {
          schemaVersion: 1,
          stateDirectory: state,
          limits: { global: 1, defaultRole: 1, perRole: {} },
        },
        {
          workerSetupProvider: provider,
          implementationBase: { resolve: async () => completed(sha) },
          runtimes: [
            {
              id: 'fixture',
              workflows: ['implementation'],
              async start() {
                starts++;

                return { state: 'running' as const, handle: {}, evidence: {} };
              },
              async inspect() {
                return { state: 'running' as const, handle: {}, evidence: {} };
              },
            },
          ],
        },
      );

      assert.ok(service.outcome === 'listening');

      try {
        const submitted = await requestLocalService(state, {
          schemaVersion: 1,
          operation: 'implement_worker_submit',
          projectId: 'project-0',
          key: 'cancel-preparing',
          description: 'Task',
        });

        assert.ok(submitted.outcome === 'persisted' && 'request' in submitted.value);

        await preparing;
        const cancelled = await requestLocalService(state, {
          schemaVersion: 1,
          operation: 'run_cancel',
          jobId: submitted.value.id,
          key: 'cancel',
          interrupt: false,
        });

        assert.ok(
          cancelled.outcome === 'persisted' &&
            'cancelRequested' in cancelled.value &&
            cancelled.value.cancelRequested,
        );

        release();

        for (let i = 0; i < 300; i++) {
          const saved = opened.workerQueue.read(submitted.value.id);

          if (saved.outcome === 'completed' && saved.value?.state === 'cancelled') {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const saved = opened.workerQueue.read(submitted.value.id);
        const job = opened.service.read(submitted.value.id);

        assert.ok(saved.outcome === 'completed' && saved.value?.state === 'cancelled');
        assert.ok(job.outcome === 'completed' && job.value === null);
        assert.equal(starts, 0);
      } finally {
        release();
        await service.close();
      }
    });
  },
);

await test('interrupted preparation without a worktree can be explicitly recovered or cancelled', async () => {
  await fixture(async ({ deps, opened, state }) => {
    let sequence = 0;
    const dependencies = {
      ...deps,
      workerQueue: opened.workerQueue,
      nextId: () => `job-recover-${++sequence}`,
    };
    const request = (key: string) => ({
      kind: 'implementer',
      submission: { schemaVersion: 1, projectId: 'project-0', key, description: 'Task' },
    });
    const first = await enqueueWorker(request('recover'), dependencies);

    assert.ok(first.outcome === 'persisted');

    const limits = { global: 1, defaultRole: 1, perRole: {} };
    const claimed = opened.workerQueue.claim(limits, { implementer: ['fixture'] });

    assert.ok(claimed.outcome === 'persisted' && claimed.value?.id === first.value.id);
    assert.equal(
      (await reconcileLocalQueuedWorker(first.value.id, false, state)).outcome,
      'rejected',
    );

    const recovered = await reconcileLocalQueuedWorker(first.value.id, true, state);

    assert.ok(recovered.outcome === 'persisted' && recovered.value.state === 'queued');
    assert.equal(
      opened.workerQueue.claim(limits, { implementer: ['fixture'] }).outcome,
      'persisted',
    );

    const cancelled = opened.workerQueue.cancel(first.value.id);

    assert.ok(cancelled.outcome === 'persisted' && cancelled.value.cancelRequested);
    assert.equal(cancelled.value.state, 'preparing');

    const settled = await reconcileLocalQueuedWorker(first.value.id, true, state);

    assert.ok(settled.outcome === 'persisted' && settled.value.state === 'cancelled');
  });
});

await test(
  'queued submissions persist without worktrees, share stable keys and reserve capacity before setup',
  { timeout: 60000 },
  async () => {
    await fixture(async ({ deps, opened }) => {
      let id = 0;
      const dependencies = {
        ...deps,
        workerQueue: opened.workerQueue,
        nextId: () => `job-queue-${++id}`,
      };
      const firstRequest = {
        kind: 'implementer',
        submission: {
          schemaVersion: 1,
          projectId: 'project-0',
          key: 'one',
          description: 'First task',
        },
      };
      const secondRequest = {
        kind: 'implementer',
        submission: {
          schemaVersion: 1,
          projectId: 'project-0',
          key: 'two',
          description: 'Second task',
        },
      };
      const first = await enqueueWorker(firstRequest, dependencies);
      const again = await enqueueWorker(firstRequest, dependencies);
      const second = await enqueueWorker(secondRequest, dependencies);

      assert.ok(
        first.outcome === 'persisted' &&
          again.outcome === 'persisted' &&
          second.outcome === 'persisted',
      );
      assert.equal(first.value.id, again.value.id);
      assert.equal(again.disposition, 'existing');
      assert.equal(first.value.state, 'queued');

      const jobs = opened.service.list();

      assert.ok(jobs.outcome === 'completed');
      assert.equal(jobs.value.items.length, 0);

      const limits = { global: 1, defaultRole: 1, perRole: {} };
      const claimed = opened.workerQueue.claim(limits, { implementer: ['fixture'] });
      const waiting = opened.workerQueue.claim(limits, { implementer: ['fixture'] });

      assert.ok(claimed.outcome === 'persisted' && claimed.value?.id === first.value.id);
      assert.ok(waiting.outcome === 'persisted' && waiting.value === null);
      assert.equal(opened.workerQueue.read(second.value.id).outcome, 'completed');

      const cancelled = opened.workerQueue.cancel(second.value.id);

      assert.ok(cancelled.outcome === 'persisted' && cancelled.value.state === 'cancelled');

      const mismatch = await enqueueWorker(
        {
          ...firstRequest,
          submission: { ...firstRequest.submission, description: 'Different task' },
        },
        dependencies,
      );

      assert.ok(mismatch.outcome === 'rejected' && mismatch.error.code === 'state_conflict');
    });
  },
);

await test(
  'service waits for capacity before creating workspaces and uses the accepted configuration',
  { timeout: 120000 },
  async () => {
    await herdrFixture(async ({ configure, opened, fake, state, sources }) => {
      await configure();
      await writeProjectConfiguration({ state, sources }, 0);
      const path = join(sources[0]!, '.astack', 'config.json');
      const config = JSON.parse(await readFile(path, 'utf8')) as {
        agents: { implementer: { workspacePrefix?: string; hooks?: { before: string } } };
      };
      config.agents.implementer.workspacePrefix = 'OLD';
      config.agents.implementer.hooks = { before: `printf x >> "${state}/hook-starts"` };
      await writeFile(path, JSON.stringify(config));
      const labels: string[] = [];
      let release = false;
      const provider = {
        ...fake.provider,
        async createWorker(
          input: NonNullable<Parameters<NonNullable<typeof fake.provider.createWorker>>[0]>,
        ) {
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

          return completed({ workspaceId: handle.workspaceId });
        },
      };
      const sha = git(sources[0]!, 'rev-parse', 'HEAD');
      const runtime = {
        id: 'fixture',
        workflows: ['implementation'],
        async start(job: { attempt: { id: string } }) {
          return {
            state: 'running' as const,
            handle: { attempt: job.attempt.id },
            evidence: {},
          };
        },
        async inspect(job: { attempt: { id: string } }) {
          return {
            state: release ? ('quiescent' as const) : ('running' as const),
            handle: { attempt: job.attempt.id },
            evidence: {},
          };
        },
      };
      const service = await startLocalService(
        {
          schemaVersion: 1,
          stateDirectory: state,
          limits: { global: 1, defaultRole: 1, perRole: {} },
        },
        {
          workerSetupProvider: provider,
          implementationBase: { resolve: async () => completed(sha) },
          runtimes: [runtime],
        },
      );

      assert.equal(service.outcome, 'listening', JSON.stringify(service));

      if (service.outcome !== 'listening') {
        return;
      }

      const waitFor = async (condition: () => boolean) => {
        for (let i = 0; i < 500 && !condition(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.ok(condition(), 'Timed out waiting for the queue');
      };

      const submit = (key: string) =>
        requestLocalService(state, {
          schemaVersion: 1,
          operation: 'implement_worker_submit',
          projectId: 'project-0',
          key,
          description: `Task ${key}`,
        });

      try {
        const first = await submit('one');

        assert.ok(first.outcome === 'persisted' && 'request' in first.value);

        const firstId = first.value.id;

        await waitFor(() => {
          const item = opened.workerQueue.read(firstId);

          return item.outcome === 'completed' && item.value?.state === 'started';
        });
        const second = await submit('two');

        assert.ok(second.outcome === 'persisted' && 'request' in second.value);

        const secondId = second.value.id;

        await new Promise((resolve) => setTimeout(resolve, 300));

        assert.equal(labels.length, 1);
        assert.equal(await readFile(join(state, 'hook-starts'), 'utf8'), 'x');

        const waiting = opened.workerQueue.read(secondId);

        assert.ok(waiting.outcome === 'completed' && waiting.value?.state === 'queued');

        const third = await submit('three');

        assert.ok(third.outcome === 'persisted' && 'request' in third.value);

        const cancelled = await requestLocalService(state, {
          schemaVersion: 1,
          operation: 'run_cancel',
          jobId: third.value.id,
          key: 'cancel-third',
          interrupt: false,
        });

        assert.ok(
          cancelled.outcome === 'persisted' &&
            'request' in cancelled.value &&
            'state' in cancelled.value &&
            cancelled.value.state === 'cancelled',
        );
        assert.equal(labels.length, 1);

        config.agents.implementer.workspacePrefix = 'NEW';
        await writeFile(path, JSON.stringify(config));
        release = true;
        await requestLocalService(state, { schemaVersion: 1, operation: 'wake' });
        await waitFor(() => labels.length === 2);
        await waitFor(() => {
          const item = opened.workerQueue.read(secondId);

          return item.outcome === 'completed' && item.value?.state === 'started';
        });

        assert.match(labels[0]!, /^OLD-/);
        assert.match(labels[1]!, /^OLD-/);
        assert.equal(await readFile(join(state, 'hook-starts'), 'utf8'), 'xx');
      } finally {
        await service.close();
      }
    });
  },
);
