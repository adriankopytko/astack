import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  acquireCoordinatorOwnership,
  authorizeRuntimeInputRetry,
  cancelRun,
  createCodexRunControl,
  inputRuntime,
  launchRuntime,
  openSqliteState,
  runtimeResultSchema,
  type OperationResult,
  type RuntimeStatus,
} from '../src/index.js';
import { fixture } from './support/runtime.js';

const options = { timeout: 90000 };
function value(result: OperationResult<RuntimeStatus>) {
  runtimeResultSchema.parse(result);

  assert.equal(result.outcome, 'completed', JSON.stringify(result));

  if (result.outcome !== 'completed') {
    assert.fail('Missing runtime result');
  }

  return result.value;
}

await test(
  'explicit retry authorization archives the exact refused generation and never sends input itself',
  options,
  async () => {
    await fixture(async ({ deps, prepare, modes, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      value(await launchRuntime(request, deps));
      modes.input = 'before';
      const input = { ...request, key: 'initial', text: 'literal; $(never-a-shell)' };
      const original = value(await inputRuntime(input, deps)).action;

      assert.ok(original);
      assert.equal(original.state, 'pending');
      assert.equal(original.generation, 0);

      const authorization = {
        ...request,
        key: original.key,
        digest: original.digest,
        generation: 0,
        notSubmitted: true,
        writerStopped: true,
      };
      const [first, duplicate] = await Promise.all([
        authorizeRuntimeInputRetry(authorization, deps),
        authorizeRuntimeInputRetry(authorization, deps),
      ]);

      assert.ok(value(first).inputRetry);
      assert.deepEqual(value(first).inputRetry, value(duplicate).inputRetry);
      assert.equal(calls.filter((call) => call.operation === 'input').length, 1);
      assert.deepEqual(deps.runtime.action(job.attempt.id, input.key), {
        schemaVersion: 1,
        outcome: 'completed',
        value: null,
      });

      const changed = await inputRuntime({ ...input, text: 'changed assignment' }, deps);

      assert.equal(changed.outcome, 'rejected');
      assert.equal(calls.filter((call) => call.operation === 'input').length, 1);

      const reopened = await openSqliteState({ schemaVersion: 1, stateDirectory: context.state });

      assert.ok(reopened.outcome === 'opened');

      try {
        const reconnected = { ...deps, runtime: reopened.runtime };
        modes.input = 'normal';
        const results = await Promise.all([
          inputRuntime(input, reconnected),
          inputRuntime(input, reconnected),
        ]);

        results.forEach((result) => value(result));
        const current = value(await inputRuntime(input, reconnected)).action;

        assert.equal(current?.state, 'acknowledged');
        assert.equal(current?.generation, 1);
        assert.equal(calls.filter((call) => call.operation === 'input').length, 2);
        assert.equal(calls.filter((call) => call.operation === 'launch').length, 1);
        assert.equal(reopened.runtime.acknowledge(original).outcome, 'rejected');

        const repeated = value(await authorizeRuntimeInputRetry(authorization, reconnected));

        assert.deepEqual(repeated.inputRetry, value(first).inputRetry);
        assert.equal(repeated.action, null);
        assert.equal(value(await inputRuntime(input, reconnected)).action?.generation, 1);
        assert.equal(calls.filter((call) => call.operation === 'input').length, 2);
        assert.equal(JSON.stringify(repeated.inputRetry).includes(input.text), false);
      } finally {
        reopened.store.close();
      }
    });
  },
);

await test(
  'missing attestations, wrong digest/generation, cancellation and changed worker cannot authorize input replay',
  options,
  async () => {
    await fixture(async ({ deps, prepare, modes, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      const launched = value(await launchRuntime(request, deps));
      modes.input = 'before';
      const original = value(
        await inputRuntime({ ...request, key: 'input', text: 'fixture' }, deps),
      ).action;

      assert.ok(original && launched.session);

      const authorization = {
        ...request,
        key: original.key,
        digest: original.digest,
        generation: original.generation,
        notSubmitted: true,
        writerStopped: true,
      };

      for (const change of [
        { notSubmitted: false },
        { writerStopped: false },
        { digest: '0'.repeat(64) },
        { generation: 1 },
      ]) {
        assert.equal(
          (await authorizeRuntimeInputRetry({ ...authorization, ...change }, deps)).outcome,
          'rejected',
        );
      }

      const agent = context.fake.snapshot(launched.session.space.target).agents[0];

      assert.ok(agent);

      const name = agent.name;
      agent.name = 'replacement';

      assert.equal(
        value(await authorizeRuntimeInputRetry(authorization, deps)).reason,
        'identity_changed',
      );

      agent.name = name;
      agent.status = 'working';

      assert.equal(value(await authorizeRuntimeInputRetry(authorization, deps)).state, 'blocked');

      agent.status = 'idle';
      const stopped = new AbortController();
      stopped.abort();

      assert.equal(
        (await authorizeRuntimeInputRetry(authorization, deps, stopped.signal)).outcome,
        'rejected',
      );

      await cancelRun(
        { schemaVersion: 1, jobId: job.job.id, key: 'cancel' },
        { runs: context.opened.runs, workerControl: createCodexRunControl(deps) },
      );

      assert.equal((await authorizeRuntimeInputRetry(authorization, deps)).outcome, 'rejected');
      assert.equal(deps.runtime.pending(job.attempt.id).outcome, 'completed');
      assert.equal(calls.filter((call) => call.operation === 'input').length, 1);
      assert.equal(deps.runtime.inputRetry(job.attempt.id, original.key, 0).outcome, 'completed');
      assert.deepEqual(deps.runtime.inputRetry(job.attempt.id, original.key, 0), {
        schemaVersion: 1,
        outcome: 'completed',
        value: null,
      });
    });
  },
);

await test(
  'an old authorization cannot clear a newer uncertain send or acknowledge it with an old receipt',
  options,
  async () => {
    await fixture(async ({ deps, prepare, modes, calls }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      value(await launchRuntime(request, deps));
      modes.input = 'before';
      const input = { ...request, key: 'input', text: 'fixture' };
      const original = value(await inputRuntime(input, deps)).action;

      assert.ok(original);

      const authorization = {
        ...request,
        key: original.key,
        digest: original.digest,
        generation: 0,
        notSubmitted: true,
        writerStopped: true,
      };
      value(await authorizeRuntimeInputRetry(authorization, deps));
      modes.input = 'after';
      const pending = value(await inputRuntime(input, deps)).action;

      assert.equal(pending?.generation, 1);
      assert.equal(pending?.state, 'pending');

      value(await authorizeRuntimeInputRetry(authorization, deps));

      assert.equal(deps.runtime.acknowledge(original).outcome, 'rejected');
      assert.equal(value(await inputRuntime(input, deps)).reason, 'action_pending');
      assert.equal(value(await inputRuntime(input, deps)).action?.generation, 1);
      assert.equal(calls.filter((call) => call.operation === 'input').length, 2);
    });
  },
);

await test(
  'retry authorization CLI refuses a running coordinator before inspecting a worker',
  options,
  async () => {
    await fixture(async ({ context }) => {
      const ownership = await acquireCoordinatorOwnership(context.state);

      try {
        const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
        const r = spawnSync(
          process.execPath,
          [
            cli,
            '--state-directory',
            context.state,
            'runtime',
            'authorize-input-retry',
            '--attempt',
            'absent',
            '--key',
            'input',
            '--digest',
            '0'.repeat(64),
            '--generation',
            '0',
            '--not-submitted',
            '--writer-stopped',
            '--json',
          ],
          { encoding: 'utf8', timeout: 10000 },
        );

        assert.equal(r.status, 1);
        assert.equal(JSON.parse(r.stdout).error.code, 'service_already_running');
      } finally {
        ownership.release();
      }
    });
  },
);
