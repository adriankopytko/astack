import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cancelRun,
  createCodexRunControl,
  launchRuntime,
  inputRuntime,
  type RunView,
  type StateWriteResult,
} from '../src/index.js';
import { fixture } from './support/runtime.js';
function accepted(result: StateWriteResult<RunView>) {
  assert.ok(result.outcome === 'persisted', JSON.stringify(result));

  return result.value;
}

await test(
  'cancelled native workers reject new input but an explicit keyed interrupt uses only the verified owned session',
  { timeout: 90000 },
  async () => {
    await fixture(async ({ deps, context, prepare, calls }) => {
      const job = await prepare();
      const launched = await launchRuntime({ schemaVersion: 1, attemptId: job.attempt.id }, deps);

      assert.ok(
        launched.outcome === 'completed' && launched.value.state === 'running',
        JSON.stringify(launched),
      );

      const controls = { runs: context.opened.runs, workerControl: createCodexRunControl(deps) };
      accepted(
        await cancelRun({ schemaVersion: 1, jobId: job.job.id, key: 'stop-dispatch' }, controls),
      );
      const blocked = await inputRuntime(
        {
          schemaVersion: 1,
          attemptId: job.attempt.id,
          key: 'late-input',
          text: 'Should not reach the worker',
        },
        deps,
      );

      assert.equal(blocked.outcome, 'rejected');
      assert.equal(calls.filter((value) => value.operation === 'input').length, 0);

      const request = {
        schemaVersion: 1,
        jobId: job.job.id,
        key: 'verified-interrupt',
        interrupt: true,
      };
      const submitted = await Promise.all([
        cancelRun(request, controls),
        cancelRun(request, controls),
      ]);
      submitted.forEach((result) => accepted(result));
      const observed = context.opened.runs.inspect(job.job.id);

      assert.ok(observed.outcome === 'completed' && observed.value);

      const cancelled = observed.value;

      assert.equal(cancelled.cancellation?.interruptState, 'acknowledged');
      assert.equal(cancelled.control.phase, 'cancel_requested');

      accepted(await cancelRun(request, controls));

      assert.equal(calls.filter((value) => value.operation === 'interrupt').length, 1);
      assert.equal(calls.filter((value) => value.operation === 'launch').length, 1);
    });
  },
);
await test(
  'cancel interrupt refuses a changed native binding and retains cancellation without sending Escape',
  { timeout: 90000 },
  async () => {
    await fixture(async ({ deps, context, prepare, calls }) => {
      const job = await prepare();
      const launched = await launchRuntime({ schemaVersion: 1, attemptId: job.attempt.id }, deps);

      assert.ok(launched.outcome === 'completed' && launched.value.session);

      const session = launched.value.session;
      const agent = context.fake
        .snapshot(session.space.target)
        .agents.find((value) => value.name === session.space.expectedAgentName);

      assert.ok(agent);

      agent.nativeSessionId = 'replacement-native-session';
      const result = accepted(
        await cancelRun(
          { schemaVersion: 1, jobId: job.job.id, key: 'unsafe-interrupt', interrupt: true },
          { runs: context.opened.runs, workerControl: createCodexRunControl(deps) },
        ),
      );

      assert.equal(result.control.phase, 'cancel_requested');
      assert.equal(result.cancellation?.interruptState, 'unknown');
      assert.equal(calls.filter((value) => value.operation === 'interrupt').length, 0);
    });
  },
);
