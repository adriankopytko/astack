import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  submitImplementation,
  createImplementationRuntime,
  createCodexHerdrRuntime,
  createCodexImplementationInput,
  nodeImplementationContextReader,
  type ImplementationDependencies,
  type ServiceJob,
} from '../src/index.js';
import { fixture } from './support/runtime.js';

await test(
  'implementation reconnect binds a lost Codex launch handle and delivers the task once without changing resource identity',
  { timeout: 90_000 },
  async () => {
    await fixture(async ({ context, deps, modes, calls }) => {
      const checkoutJob = await context.worker('implementation-runtime');
      let sequence = 0;
      const implementation: ImplementationDependencies = {
        ...deps,
        queue: context.opened.service,
        worktrees: context.opened.worktrees,
        instructions: nodeImplementationContextReader,
        now: () => 1000,
        nextId: (kind) => `${kind}-implementation-runtime-${++sequence}`,
      };
      const accepted = await submitImplementation(
        {
          schemaVersion: 1,
          projectId: checkoutJob.job.projectId,
          checkoutId: checkoutJob.job.checkoutId,
          key: 'implementation',
          branch: checkoutJob.entry.branch,
          commit: checkoutJob.entry.commit,
          description: 'Implement the fixture task without publishing.',
        },
        implementation,
      );

      assert.ok(accepted.outcome === 'persisted', JSON.stringify(accepted));

      const jobId = accepted.value.job.job.id;
      const claimed = context.opened.service.claim({
        jobId,
        owner: 'implementation-runtime-service',
        token: 'implementation-runtime-claim',
        now: 1000,
        limits: { global: 4, defaultRole: 4, perRole: {} },
      });

      assert.ok(claimed.outcome === 'persisted' && claimed.value);

      const runtime = createImplementationRuntime({
        runtime: createCodexHerdrRuntime(deps),
        dependencies: implementation,
        workerInput: createCodexImplementationInput(deps),
      });
      const signal = new AbortController().signal;
      modes.launch = 'after';
      const unknown = await runtime.start(claimed.value, signal);

      assert.equal(unknown.state, 'unknown');

      const first = context.opened.service.observe(jobId, unknown, 1000);

      assert.ok(first.outcome === 'persisted', JSON.stringify(first));

      const handle = first.value.entry.observation?.handle;
      modes.launch = 'normal';
      const recovered = await runtime.inspect(first.value, signal);

      assert.equal(recovered.state, 'running', JSON.stringify(recovered));
      assert.deepEqual(recovered.handle, handle);

      const started = context.opened.service.observe(jobId, recovered, 1000);

      assert.ok(started.outcome === 'persisted', JSON.stringify(started));
      assert.equal(started.value.entry.state, 'started');

      const repeat = await runtime.inspect(started.value as ServiceJob, signal);

      assert.equal(repeat.state, 'running');
      assert.equal(calls.filter((call) => call.operation === 'launch').length, 1);
      assert.equal(calls.filter((call) => call.operation === 'input').length, 1);

      const prompt = calls.find((call) => call.operation === 'input')?.text ?? '';

      assert.ok(prompt.includes(jobId));
      assert.ok(prompt.includes('Result contract v1'));
      assert.equal(prompt.includes('dangerously-bypass'), false);
    });
  },
);
