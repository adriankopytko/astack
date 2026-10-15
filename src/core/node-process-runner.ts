import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { rejected } from '../contracts/operation-result.js';
import type { ProcessExecution, ProcessRequest, ProcessResult } from '../contracts/process.js';
import {
  prepareProcessArtifacts,
  ProcessOutputCollector,
  systemErrorCode,
} from './process-output.js';

type GroupState = ProcessExecution['shutdown']['processGroup'];

function inspectGroup(pid: number): GroupState {
  try {
    process.kill(-pid, 0);

    return 'present';
  } catch (error) {
    if (systemErrorCode(error) === 'EPERM') {
      return 'unknown';
    }

    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return 'absent';
    }

    return 'unknown';
  }
}

async function run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return rejected(
      'unsupported_platform',
      'Process groups are supported on Linux and macOS only.',
    );
  }

  const stdout = new ProcessOutputCollector(
    request.maxCaptureBytes,
    request.artifacts?.maxBytesPerStream ?? 0,
  );
  const stderr = new ProcessOutputCollector(
    request.maxCaptureBytes,
    request.artifacts?.maxBytesPerStream ?? 0,
  );
  const result: ProcessExecution = {
    schemaVersion: 1,
    outcome: 'exited',
    pid: null,
    exitCode: null,
    signal: null,
    stdout: stdout.output,
    stderr: stderr.output,
    shutdown: {
      root: 'not_started',
      processGroup: 'not_started',
      termSent: false,
      killSent: false,
    },
    error: null,
  };
  const recordFailure = (code: NonNullable<ProcessExecution['error']>['code'], error: unknown) => {
    result.error ??= { code, systemCode: systemErrorCode(error) };
  };

  if (signal?.aborted) {
    result.outcome = 'cancelled';

    return result;
  }

  try {
    await prepareProcessArtifacts(request, stdout, stderr);
  } catch (error) {
    result.outcome = 'io_failed';
    recordFailure('artifact_setup_failed', error);
    await stdout.finish(() => {});
    await stderr.finish(() => {});

    return result;
  }

  if (signal?.aborted) {
    result.outcome = 'cancelled';
    await stdout.finish(() => {});
    await stderr.finish(() => {});

    return result;
  }

  const startedAt = performance.now();
  let child;

  try {
    child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    result.outcome = 'spawn_failed';
    recordFailure('spawn_failed', error);
    await stdout.finish(() => {});
    await stderr.finish(() => {});

    return result;
  }

  let spawned = false;
  let rootExited = false;
  let spawnFailed = false;
  let stopAt: number | undefined;
  let killAttempted = false;
  let groupAbsent = false;
  let finished = false;

  const groupState = (): GroupState => {
    if (!spawned || result.pid === null) {
      return 'not_started';
    }

    if (groupAbsent) {
      return 'absent';
    }

    const state = inspectGroup(result.pid);
    groupAbsent = state === 'absent';

    return state;
  };

  const sendSignal = (name: 'SIGTERM' | 'SIGKILL'): boolean => {
    if (result.pid === null || !spawned || groupState() === 'absent') {
      return false;
    }

    try {
      process.kill(-result.pid, name);

      return true;
    } catch (error) {
      if (groupState() !== 'absent') {
        recordFailure('signal_failed', error);
      }

      return false;
    }
  };

  const stop = (outcome: ProcessExecution['outcome']) => {
    if (stopAt === undefined) {
      result.outcome = outcome;
      stopAt = performance.now();
      result.shutdown.termSent = sendSignal('SIGTERM');
    }
  };

  child.on('spawn', () => {
    if (finished) {
      return;
    }

    spawned = true;
    result.pid = child.pid ?? null;
    result.shutdown.root = 'unverified';
    result.shutdown.processGroup = 'unknown';

    if (stopAt !== undefined) {
      result.shutdown.termSent = sendSignal('SIGTERM');
    }
  });
  child.on('exit', (code, exitSignal) => {
    if (finished) {
      return;
    }

    rootExited = true;
    result.exitCode = code;
    result.signal = exitSignal;
    result.shutdown.root = 'exited';
  });
  child.on('error', (error) => {
    if (finished) {
      return;
    }

    if (!spawned) {
      spawnFailed = true;
      result.outcome = 'spawn_failed';
      recordFailure('spawn_failed', error);
    } else {
      recordFailure('output_failed', error);
      stop('io_failed');
    }
  });

  const outputFailure = (error: unknown) => {
    if (spawnFailed) {
      return;
    }

    recordFailure('output_failed', error);
    stop('io_failed');
  };

  const stdoutTask = stdout.collect(child.stdout, outputFailure);
  const stderrTask = stderr.collect(child.stderr, outputFailure);

  while (true) {
    if (spawnFailed) {
      break;
    }

    const group = rootExited || stopAt !== undefined ? groupState() : 'unknown';

    if (rootExited && group === 'absent' && stdout.done && stderr.done) {
      break;
    }

    if (signal?.aborted) {
      stop('cancelled');
    } else if (performance.now() - startedAt >= request.timeoutMs) {
      stop('timed_out');
    } else if (rootExited && group !== 'absent') {
      stop('descendants_remaining');
    }

    if (stopAt !== undefined) {
      const elapsed = performance.now() - stopAt;

      if (!killAttempted && elapsed >= request.terminationGraceMs) {
        killAttempted = true;
        result.shutdown.killSent = sendSignal('SIGKILL');
      }

      if (elapsed >= request.terminationGraceMs + request.shutdownWaitMs) {
        break;
      }
    }

    await delay(20);
  }

  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  await Promise.all([stdoutTask, stderrTask]);
  result.shutdown.processGroup = groupState();
  finished = true;

  return result;
}

/** Injectable local implementation. Call through executeProcess to validate external input. */
export const nodeProcessRunner = { run };
