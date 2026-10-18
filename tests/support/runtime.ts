import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture as herdrFixture } from './herdr.js';
import { completed, rejected } from '../../src/contracts/operation-result.js';
import type { RuntimeDependencies, ServiceJob, HerdrSpace } from '../../src/index.js';

interface FixturePolicy {
  project: {
    hooks?: { setup: string };
    roles: {
      implementer: { runtime: string; command: string };
      reviewer: { runtime: string; command: string };
    };
  };
  execution: {
    enabled: boolean;
    allowedRuntimes: string[];
    commands: { 'fixture-worker': { executable: string; args: string[] } };
  };
}

export const nativeArgs = [
  '--sandbox',
  'workspace-write',
  '--ask-for-approval',
  'on-request',
  '--no-daemon',
  '--no-alt-screen',
];
export async function fixture(
  action: (context: {
    deps: RuntimeDependencies;
    context: Parameters<Parameters<typeof herdrFixture>[0]>[0];
    calls: { operation: string; text?: string }[];
    modes: { launch: string; input: string; interrupt: string };
    prepare: (key?: string) => Promise<ServiceJob>;
    policy: (change: (value: FixturePolicy) => void) => Promise<void>;
  }) => Promise<void>,
) {
  await herdrFixture(async (context) => {
    const calls: { operation: string; text?: string }[] = [];
    const modes = { launch: 'normal', input: 'normal', interrupt: 'normal' };
    const policy = async (change: (value: FixturePolicy) => void) => {
      const path = join(context.state, 'config/project-0.json');
      const value = JSON.parse(await readFile(path, 'utf8')) as FixturePolicy;
      change(value);
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    };

    await policy((value) => {
      value.project.roles.implementer = { runtime: 'codex-herdr', command: 'fixture-worker' };
      value.execution.allowedRuntimes = ['codex-herdr'];
      value.execution.commands['fixture-worker'].args = nativeArgs;
    });
    const occupant = (space: HerdrSpace) => {
      assert.ok(space.handle);

      const value = {
        ...space.handle,
        name: space.expectedAgentName,
        kind: 'codex',
        nativeSessionId: modes.launch === 'missing-native' ? null : `native-${space.attemptId}`,
        cwd: space.root,
        foregroundCwd: space.root,
        status: 'idle' as const,
      };
      context.fake.snapshot(space.target).agents.push(value);

      return value;
    };

    const deps: RuntimeDependencies = {
      ...context.deps,
      runtime: context.opened.runtime,
      queue: context.opened.service,
      canonicalCodexExecutable: process.execPath,
      worker: {
        async launch({ space, args }) {
          calls.push({ operation: 'launch' });

          assert.deepEqual(args, nativeArgs);

          const stored = context.opened.runtime.read(space.attemptId ?? '');

          assert.ok(stored.outcome === 'completed' && stored.value?.phase === 'pending');

          if (modes.launch === 'before') {
            throw new Error('fixture-private-launch-error');
          }

          const agent = occupant(space);

          if (modes.launch === 'wrong-pane') {
            agent.paneId = 'wrong-pane';
          }

          if (modes.launch === 'after') {
            throw new Error('fixture-private-launch-error');
          }

          return completed(null);
        },
        async input(_space, text) {
          calls.push({ operation: 'input', text });

          if (modes.input === 'before') {
            return rejected('herdr_unavailable', 'Fixture refused before delivery.');
          }

          if (modes.input === 'after') {
            throw new Error('fixture-private-input-error');
          }

          return completed(null);
        },
        async interrupt() {
          calls.push({ operation: 'interrupt' });

          if (modes.interrupt === 'after') {
            throw new Error('fixture-private-interrupt-error');
          }

          return completed(null);
        },
      },
    };
    await context.configure();
    const prepare = async (key = 'runtime-worker') => {
      const job = await context.worker(key);
      const claimed = context.opened.service.claim({
        jobId: job.job.id,
        owner: 'fixture-service',
        token: `claim-${key}`,
        now: 1000,
        limits: { global: 4, defaultRole: 4, perRole: {} },
      });

      assert.ok(claimed.outcome === 'persisted' && claimed.value);

      return claimed.value;
    };

    await action({ deps, context, calls, modes, prepare, policy });
  });
}
