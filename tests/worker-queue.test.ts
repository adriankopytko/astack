import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueHandoff } from '../src/application/enqueue-handoff.js';
import { fixture } from './support/service.js';
import { fixture as herdrFixture } from './support/herdr.js';
import { git, writeProjectConfiguration } from './support/service.js';
import { startLocalService } from '../src/host/local-service.js';
import { requestLocalService } from '../src/adapters/local/service-client.js';
import { completed } from '../src/contracts/operation-result.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reconcileLocalQueuedWorker } from '../src/host/reconcile-run.js';

await test('cancellation during preparation does not alias or cancel an existing job', async () => {
  await fixture(async ({ deps, opened }) => {
    const request = {
      schemaVersion: 1,
      projectId: 'project-0',
      agent: 'implementer',
      key: 'cancel-alias',
      task: 'Task',
    };
    const queued = await enqueueHandoff(request, {
      ...deps,
      workerQueue: opened.workerQueue,
      nextId: () => 'job-alias',
    });

    assert.ok(queued.outcome === 'persisted');

    const claimed = opened.workerQueue.claim(
      { global: 1, defaultRole: 1, perRole: {} },
      { handoff: ['fixture'] },
    );

    assert.ok(claimed.outcome === 'persisted' && claimed.value);
    assert.equal(opened.workerQueue.cancel(queued.value.id).outcome, 'persisted');

    const settled = opened.workerQueue.alias(queued.value.id, 'job-existing');

    assert.ok(settled.outcome === 'persisted');
    assert.equal(settled.value.state, 'cancelled');
    assert.equal(settled.value.jobId, null);
  });
});

await test('issue assignments save one immutable issue snapshot and retries do not refetch', async () => {
  await fixture(async ({ deps, opened }) => {
    let calls = 0;
    const reference = { host: 'github.com', repository: 'example/project', number: 42 };
    const dependencies = {
      ...deps,
      workerQueue: opened.workerQueue,
      nextId: () => 'job-issue',
      githubContext: {
        async read() {
          calls++;

          return completed({
            kind: 'issue' as const,
            reference: 'github.com/example/project#42',
            title: 'Fix it',
            body: 'Issue details',
            state: 'open' as const,
            observedAt: 123,
          });
        },
      },
    };
    const request = {
      schemaVersion: 1,
      projectId: 'project-0',
      agent: 'implementer',
      key: 'issue',
      task: 'Implement the issue',
      context: { kind: 'issue' as const, ...reference },
    };
    const first = await enqueueHandoff(request, dependencies);
    const again = await enqueueHandoff(request, dependencies);

    assert.ok(first.outcome === 'persisted' && again.outcome === 'persisted');
    assert.equal(calls, 1);

    const saved = opened.workerQueue.read(first.value.id);

    assert.ok(saved.outcome === 'completed' && saved.value);
    assert.equal(saved.value.contextSnapshot?.body, 'Issue details');
    assert.equal(saved.value.contextSnapshot?.observedAt, 123);
  });
});

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
          operation: 'handoff_submit',
          projectId: 'project-0',
          key: 'cancel-preparing',
          agent: 'implementer',
          task: 'Task',
          instructionPaths: ['AGENTS.md', 'AGENTS.override.md'],
          request: {},
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
      schemaVersion: 1,
      projectId: 'project-0',
      agent: 'implementer',
      key,
      task: 'Task',
    });
    const first = await enqueueHandoff(request('recover'), dependencies);

    assert.ok(first.outcome === 'persisted');

    const limits = { global: 1, defaultRole: 1, perRole: {} };
    const claimed = opened.workerQueue.claim(limits, { handoff: ['fixture'] });

    assert.ok(claimed.outcome === 'persisted' && claimed.value?.id === first.value.id);
    assert.equal(
      (await reconcileLocalQueuedWorker(first.value.id, false, state)).outcome,
      'rejected',
    );

    const recovered = await reconcileLocalQueuedWorker(first.value.id, true, state);

    assert.ok(recovered.outcome === 'persisted' && recovered.value.state === 'queued');
    assert.equal(opened.workerQueue.claim(limits, { handoff: ['fixture'] }).outcome, 'persisted');

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
        schemaVersion: 1,
        projectId: 'project-0',
        agent: 'implementer',
        key: 'one',
        task: 'First task',
      };
      const secondRequest = { ...firstRequest, key: 'two', task: 'Second task' };
      const first = await enqueueHandoff(firstRequest, dependencies);
      const again = await enqueueHandoff(firstRequest, dependencies);
      const second = await enqueueHandoff(secondRequest, dependencies);

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
      const claimed = opened.workerQueue.claim(limits, { handoff: ['fixture'] });
      const waiting = opened.workerQueue.claim(limits, { handoff: ['fixture'] });

      assert.ok(claimed.outcome === 'persisted' && claimed.value?.id === first.value.id);
      assert.ok(waiting.outcome === 'persisted' && waiting.value === null);
      assert.equal(opened.workerQueue.read(second.value.id).outcome, 'completed');

      const cancelled = opened.workerQueue.cancel(second.value.id);

      assert.ok(cancelled.outcome === 'persisted' && cancelled.value.state === 'cancelled');

      const mismatch = await enqueueHandoff(
        {
          ...firstRequest,
          task: 'Different task',
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
        agents: Record<string, { workspacePrefix?: string; hooks?: { before: string } }>;
      };
      config.agents.backend = {
        ...config.agents.implementer!,
        workspacePrefix: 'OLD',
        hooks: { before: `printf x >> "${state}/hook-starts"` },
      };
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
          operation: 'handoff_submit',
          projectId: 'project-0',
          key,
          agent: 'backend',
          task: `Task ${key}`,
          instructionPaths: ['AGENTS.md', 'AGENTS.override.md'],
          request: {},
        });

      try {
        const first = await submit('one');

        assert.ok(first.outcome === 'persisted' && 'request' in first.value);

        const firstId = first.value.id;

        await waitFor(() => {
          const item = opened.workerQueue.read(firstId);

          return item.outcome === 'completed' && item.value?.state === 'started';
        });
        const repeated = await submit('one');

        assert.ok(repeated.outcome === 'persisted' && 'request' in repeated.value);
        assert.equal(repeated.value.id, firstId);

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

        config.agents.backend!.workspacePrefix = 'NEW';
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

await test('obsolete queued records do not block new handoffs and remain untouched', async () => {
  await fixture(async ({ deps, opened, state }) => {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(state, 'state.sqlite'));

    try {
      database
        .prepare(
          'INSERT INTO worker_requests(id,project_id,kind,request_key,state,created_at,data) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          'legacy-queued',
          'project-0',
          'implementer',
          'old',
          'queued',
          1,
          JSON.stringify({ legacy: true }),
        );
      const queued = await enqueueHandoff(
        {
          schemaVersion: 1,
          projectId: 'project-0',
          agent: 'implementer',
          key: 'new',
          task: 'Task',
        },
        { ...deps, workerQueue: opened.workerQueue, nextId: () => 'new-handoff' },
      );

      assert.equal(queued.outcome, 'persisted');

      const counts = opened.workerQueue.counts();

      assert.ok(counts.outcome === 'completed');
      assert.equal(counts.value.queued, 1);

      const claimed = opened.workerQueue.claim(
        { global: 1, defaultRole: 1, perRole: {} },
        { handoff: ['fixture'] },
      );

      assert.ok(claimed.outcome === 'persisted' && claimed.value?.id === 'new-handoff');
      assert.equal(
        database.prepare('SELECT state FROM worker_requests WHERE id=?').get('legacy-queued')
          ?.state,
        'queued',
      );
    } finally {
      database.close();
    }
  });
});
