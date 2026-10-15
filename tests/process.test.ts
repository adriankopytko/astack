import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  executeProcess,
  nodeProcessRunner,
  processExecutionSchema,
  processResultSchema,
  type ProcessExecution,
} from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/process-child.mjs', import.meta.url));
const options = { timeout: 15_000 };

function input(cwd: string, mode = 'inspect', args: string[] = []) {
  return {
    schemaVersion: 1,
    executable: process.execPath,
    args: [fixture, mode, ...args],
    cwd,
    env: {},
    timeoutMs: 3000,
    terminationGraceMs: 100,
    shutdownWaitMs: 300,
  };
}

async function run(request: unknown, signal?: AbortSignal): Promise<ProcessExecution> {
  const result = processResultSchema.parse(
    await executeProcess(request, nodeProcessRunner, signal),
  );

  if (result.outcome === 'rejected') {
    assert.fail(result.error.message);
  }

  return result;
}

async function temporary(check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'astack process '));

  try {
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 5000;

  while (true) {
    try {
      await stat(path);

      return;
    } catch {
      if (performance.now() > deadline) {
        assert.fail('Fixture did not become ready');
      }

      await delay(10);
    }
  }
}

await test(
  'process validation rejects invalid requests before invoking an injected runner',
  options,
  async () => {
    let calls = 0;
    const runner = {
      run: () => {
        calls++;

        throw new Error('Should not run');
      },
    };
    const request = input('/work');

    for (const invalid of [
      { ...request, cwd: 'relative' },
      { ...request, executable: 'node' },
      { ...request, executable: './node', env: { PATH: '/bin' } },
      { ...request, args: ['invalid\0argument'] },
      { ...request, env: { 'A=B': 'invalid' } },
      { ...request, env: { VALUE: 'invalid\0value' } },
      { ...request, timeoutMs: 0 },
      { ...request, shell: true },
      { ...request, maxCaptureBytes: 20 * 1024 * 1024 },
    ]) {
      const result = await executeProcess(invalid, runner);

      assert.equal(result.outcome, 'rejected');

      if (result.outcome === 'rejected') {
        assert.equal(result.error.code, 'invalid_request');
      }
    }

    const unsupported = await executeProcess({ ...request, schemaVersion: 2 }, runner);

    assert.equal(unsupported.outcome, 'rejected');

    if (unsupported.outcome === 'rejected') {
      assert.equal(unsupported.error.code, 'unsupported_contract_version');
    }

    assert.equal(calls, 0);
  },
);

await test(
  'injected runners receive explicit input, defaults, and the same cancellation signal',
  options,
  async () => {
    const controller = new AbortController();
    let calls = 0;
    await executeProcess(
      input('/work'),
      {
        run: (request, signal) => {
          calls++;

          assert.equal(request.maxCaptureBytes, 64 * 1024);
          assert.deepEqual(request.env, {});
          assert.equal(signal, controller.signal);

          return Promise.resolve({
            schemaVersion: 1,
            outcome: 'rejected',
            error: { code: 'unsupported_platform', message: 'Fixture' },
          });
        },
      },
      controller.signal,
    );

    assert.equal(calls, 1);
  },
);

await test(
  'arguments and paths with spaces remain literal and environment is not inherited',
  options,
  async () => {
    await temporary(async (directory) => {
      const executable = join(directory, 'node runner');
      const sentinel = join(directory, 'must-not-exist');
      const args = ['hello world', `$(touch '${sentinel}')`, '; echo unsafe', '*', '"quoted"'];
      await symlink(process.execPath, executable);
      const previous = process.env.ASTACK_PROCESS_AMBIENT_SECRET;
      process.env.ASTACK_PROCESS_AMBIENT_SECRET = 'not-inherited';

      try {
        const result = await run({
          ...input(directory, 'inspect', args),
          executable,
          env: { VALUE: 'chosen' },
        });
        const observed: unknown = JSON.parse(result.stdout.text);

        assert.equal(result.outcome, 'exited');
        assert.equal(result.exitCode, 0);
        assert.equal(result.shutdown.root, 'exited');
        assert.equal(result.shutdown.processGroup, 'absent');
        assert.equal(result.stdout.complete, true);
        assert.deepEqual(observed, {
          args,
          cwd: await realpath(directory),
          value: 'chosen',
          ambient: null,
        });

        await assert.rejects(stat(sentinel), { code: 'ENOENT' });
      } finally {
        if (previous === undefined) {
          delete process.env.ASTACK_PROCESS_AMBIENT_SECRET;
        } else {
          process.env.ASTACK_PROCESS_AMBIENT_SECRET = previous;
        }
      }
    });
  },
);

await test('bare executable lookup uses only the explicit PATH', options, async () => {
  await temporary(async (directory) => {
    const result = await run({
      ...input(directory),
      executable: basename(process.execPath),
      env: { PATH: dirname(process.execPath) },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.outcome, 'exited');
  });
});

await test(
  'result decoding rejects contradictory capture and shutdown evidence',
  options,
  async () => {
    await temporary(async (directory) => {
      const result = await run(input(directory));

      for (const invalid of [
        { ...result, schemaVersion: 2 },
        { ...result, pid: null },
        { ...result, exitCode: null, signal: null },
        { ...result, signal: 'SIGTERM' },
        { ...result, shutdown: { ...result.shutdown, root: 'unverified' } },
        { ...result, stdout: { ...result.stdout, capturedBytes: result.stdout.observedBytes + 1 } },
        { ...result, stdout: { ...result.stdout, truncated: true } },
        {
          ...result,
          stdout: {
            ...result.stdout,
            artifact: {
              path: join(directory, 'artifact'),
              writtenBytes: 0,
              truncated: true,
              complete: true,
            },
          },
        },
      ]) {
        assert.equal(processResultSchema.safeParse(invalid).success, false);
      }
    });
  },
);

await test(
  'nonzero exits and externally delivered signals retain distinct evidence',
  options,
  async () => {
    await temporary(async (directory) => {
      const failed = await run(input(directory, 'exit', ['23']));
      const signalled = await run(input(directory, 'signal'));

      assert.equal(failed.outcome, 'exited');
      assert.equal(failed.exitCode, 23);
      assert.equal(failed.signal, null);
      assert.equal(signalled.outcome, 'exited');
      assert.equal(signalled.exitCode, null);
      assert.equal(signalled.signal, 'SIGTERM');
    });
  },
);

await test(
  'spawn failures return safe system codes without arguments, paths, or environment dumps',
  options,
  async () => {
    await temporary(async (directory) => {
      for (const request of [
        { ...input(directory), executable: join(directory, 'private-marker') },
        { ...input(join(directory, 'private-marker')) },
      ]) {
        const result = await run({
          ...request,
          env: { TOKEN: 'private-marker' },
          args: ['private-marker'],
        });

        assert.equal(result.outcome, 'spawn_failed');
        assert.equal(result.error?.systemCode, 'ENOENT');
        assert.equal(result.pid, null);
        assert.equal(result.shutdown.root, 'not_started');
        assert.equal(result.shutdown.processGroup, 'not_started');
        assert.doesNotMatch(JSON.stringify(result), /private-marker/);
      }
    });
  },
);

await test(
  'stdout and stderr remain bounded while oversized streams are fully drained',
  options,
  async () => {
    await temporary(async (directory) => {
      const result = await run({
        ...input(directory, 'output', ['262144', '131072']),
        maxCaptureBytes: 1024,
        artifacts: { directory, maxBytesPerStream: 512 * 1024 },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.text, 'x'.repeat(1024));
      assert.equal(result.stderr.text, 'y'.repeat(1024));
      assert.equal(result.stdout.observedBytes, 262144);
      assert.equal(result.stderr.observedBytes, 131072);
      assert.equal(result.stdout.capturedBytes, 1024);
      assert.equal(result.stdout.truncated, true);
      assert.equal(result.stderr.truncated, true);
      assert.equal(result.stdout.complete, true);
      assert.equal(result.stderr.complete, true);
      assert.ok(result.stdout.artifact);
      assert.equal(result.stdout.artifact.writtenBytes, 262144);
      assert.equal(result.stdout.artifact.complete, true);
      assert.equal((await readFile(result.stdout.artifact.path)).length, 262144);
    });
  },
);

await test('zero capture budgets discard text without stopping the process', options, async () => {
  await temporary(async (directory) => {
    const result = await run({ ...input(directory, 'output', ['10', '5']), maxCaptureBytes: 0 });

    assert.equal(result.stdout.text, '');
    assert.equal(result.stdout.capturedBytes, 0);
    assert.equal(result.stdout.observedBytes, 10);
    assert.equal(result.stdout.truncated, true);
    assert.equal(result.exitCode, 0);
  });
});

await test(
  'private artifacts preserve bytes independently of lossy bounded text capture',
  options,
  async () => {
    await temporary(async (directory) => {
      const result = await run({
        ...input(directory, 'binary'),
        maxCaptureBytes: 2,
        artifacts: { directory, maxBytesPerStream: 100 },
      });
      const artifact = result.stdout.artifact;

      assert.ok(artifact);
      assert.equal(result.stdout.observedBytes, 5);
      assert.equal(result.stdout.capturedBytes, 2);
      assert.equal(result.stdout.truncated, true);
      assert.equal(artifact.complete, true);
      assert.equal(artifact.truncated, false);
      assert.deepEqual(await readFile(artifact.path), Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff]));
      assert.equal((await stat(artifact.path)).mode & 0o077, 0);
      assert.equal((await stat(dirname(artifact.path))).mode & 0o077, 0);
    });
  },
);

await test(
  'artifact budgets retain only a reported prefix and never overwrite an earlier run',
  options,
  async () => {
    await temporary(async (directory) => {
      const request = {
        ...input(directory, 'output', ['64', '32']),
        maxCaptureBytes: 8,
        artifacts: { directory, maxBytesPerStream: 16 },
      };
      const first = await run(request);
      const second = await run(request);

      assert.ok(first.stdout.artifact);
      assert.ok(second.stdout.artifact);
      assert.notEqual(first.stdout.artifact.path, second.stdout.artifact.path);
      assert.equal(first.stdout.artifact.writtenBytes, 16);
      assert.equal(first.stdout.artifact.truncated, true);
      assert.equal(first.stdout.artifact.complete, false);
      assert.equal(first.stdout.complete, true);
      assert.equal((await readFile(first.stdout.artifact.path)).toString(), 'x'.repeat(16));
    });
  },
);

await test('artifact setup failure starts no process', options, async () => {
  await temporary(async (directory) => {
    const result = await run({
      ...input(directory),
      artifacts: { directory: join(directory, 'missing'), maxBytesPerStream: 100 },
    });

    assert.equal(result.outcome, 'io_failed');
    assert.equal(result.error?.code, 'artifact_setup_failed');
    assert.equal(result.shutdown.root, 'not_started');
    assert.equal(result.pid, null);
  });
});

await test(
  'already cancelled requests start no process and create no artifacts',
  options,
  async () => {
    await temporary(async (directory) => {
      const controller = new AbortController();
      controller.abort();
      const result = await run(
        {
          ...input(directory),
          artifacts: { directory: join(directory, 'missing'), maxBytesPerStream: 100 },
        },
        controller.signal,
      );

      assert.equal(result.outcome, 'cancelled');
      assert.equal(result.pid, null);
      assert.equal(result.error, null);
      assert.equal(result.stdout.artifact, null);
    });
  },
);

await test('timeouts retain their cause separately from verified shutdown', options, async () => {
  await temporary(async (directory) => {
    const before = performance.now();
    const result = await run({ ...input(directory, 'wait'), timeoutMs: 100 });

    assert.equal(result.outcome, 'timed_out');
    assert.equal(result.shutdown.termSent, true);
    assert.equal(result.shutdown.root, 'exited');
    assert.equal(result.shutdown.processGroup, 'absent');
    assert.ok(performance.now() - before < 5000);
  });
});

await test('cancellation escalates when the owned process ignores SIGTERM', options, async () => {
  await temporary(async (directory) => {
    const marker = join(directory, 'ready');
    const controller = new AbortController();
    const pending = run(input(directory, 'ignore-term', [marker]), controller.signal);
    await waitForFile(marker);
    controller.abort();
    const result = await pending;

    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.shutdown.termSent, true);
    assert.equal(result.shutdown.killSent, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.shutdown.processGroup, 'absent');
  });
});

await test(
  'children outliving the parent are terminated through the owned process group',
  options,
  async () => {
    await temporary(async (directory) => {
      const marker = join(directory, 'descendant');
      const terminated = join(directory, 'terminated');
      const result = await run(input(directory, 'orphan', [marker, terminated]));

      assert.equal(result.outcome, 'descendants_remaining');
      assert.equal(result.exitCode, 0);
      assert.equal(result.shutdown.root, 'exited');
      assert.equal(result.shutdown.termSent, true);
      assert.equal(await readFile(terminated, 'utf8'), 'terminated');
      // An orphan zombie can keep a group present until the OS reaps it.
      assert.ok(['absent', 'present'].includes(result.shutdown.processGroup));
    });
  },
);

await test(
  'escaped children cannot keep collection open indefinitely or be claimed as stopped',
  options,
  async () => {
    await temporary(async (directory) => {
      const marker = join(directory, 'escaped');
      const terminated = join(directory, 'terminated');
      let escapedPid: number | undefined;

      try {
        const result = await run({
          ...input(directory, 'escaped', [marker, terminated]),
          timeoutMs: 1000,
        });
        escapedPid = Number(await readFile(marker, 'utf8'));

        assert.equal(result.outcome, 'timed_out');
        assert.equal(result.shutdown.root, 'exited');
        assert.equal(result.shutdown.processGroup, 'absent');
        assert.equal(result.stdout.complete, false);
        assert.equal(result.shutdown.termSent, false);
        assert.equal(result.shutdown.killSent, false);
        assert.ok(escapedPid > 1);
        assert.doesNotThrow(() => process.kill(escapedPid ?? 0, 0));

        processExecutionSchema.parse(result);
      } finally {
        if (escapedPid === undefined) {
          const saved = await readFile(marker, 'utf8').catch(() => null);
          escapedPid = saved === null ? undefined : Number(saved);
        }

        if (escapedPid !== undefined && escapedPid > 1) {
          try {
            process.kill(escapedPid, 'SIGKILL');
          } catch (error) {
            // The fixture also self-expires; never signal an unrelated group.
            assert.ok(error instanceof Error && 'code' in error && error.code === 'ESRCH');
          }
        }
      }
    });
  },
);
