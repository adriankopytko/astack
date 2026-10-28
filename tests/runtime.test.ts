import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  launchRuntime,
  inspectRuntime,
  reconcileRuntime,
  inputRuntime,
  interruptRuntime,
  runtimeResultSchema,
  runtimeCapabilities,
  createCodexHerdrRuntime,
  createServiceCoordinator,
  createHerdrCliProvider,
  processRequestSchema,
  type RuntimeStatus,
  type OperationResult,
  type ProcessRequest,
  type ProcessResult,
} from '../src/index.js';
import { fixture, nativeArgs } from './support/runtime.js';

const options = { timeout: 90_000 };
function value(result: OperationResult<RuntimeStatus>): RuntimeStatus {
  runtimeResultSchema.parse(result);

  if (result.outcome !== 'completed') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

await test(
  'launch persists stable attempt identity before the effect, binds native session, and reuses without another writer',
  options,
  async () => {
    await fixture(async ({ prepare, deps, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      const [first, second] = await Promise.all([
        launchRuntime(request, deps),
        launchRuntime(request, deps),
      ]);
      const ready = value(await reconcileRuntime(request, deps));

      assert.equal(ready.state, 'running', JSON.stringify([first, second, ready]));
      assert.equal(ready.session?.phase, 'ready');
      assert.equal(ready.session?.agent?.nativeSessionId, `native-${job.attempt.id}`);
      assert.equal(calls.filter((call) => call.operation === 'launch').length, 1);
      assert.ok(ready.session?.launchId.startsWith('launch-'));
      assert.equal(
        value(await launchRuntime(request, deps)).session?.launchId,
        ready.session?.launchId,
      );

      const resource = context.opened.store.inspectRecord({
        schemaVersion: 1,
        entity: 'resource',
        id: `runtime:${ready.session?.launchId}`,
      });

      assert.ok(
        resource.outcome === 'completed' &&
          resource.value?.entity === 'resource' &&
          resource.value.record.releasedAt === null,
      );
    });
  },
);

await test(
  'workers without native IDs bind, recover and accept keyed controls while preserving uncertain input',
  options,
  async () => {
    await fixture(async ({ prepare, deps, modes, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      modes.launch = 'missing-native';
      const ready = value(await launchRuntime(request, deps));

      assert.equal(ready.state, 'running');
      assert.equal(ready.session?.phase, 'ready');
      assert.ok(ready.session);
      assert.equal(ready.session.agent?.nativeSessionId, null);

      const { openSqliteState } = await import('../src/index.js');
      const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: context.state });

      assert.equal(opened.outcome, 'opened');

      if (opened.outcome !== 'opened') {
        assert.fail('Missing reopened state');
      }

      try {
        const reconnected = { ...deps, runtime: opened.runtime, herdr: opened.herdr };

        assert.equal(value(await reconcileRuntime(request, reconnected)).state, 'running');
        assert.equal(
          value(await launchRuntime(request, reconnected)).session?.launchId,
          ready.session.launchId,
        );

        const input = { ...request, key: 'without-native', text: 'fixture assignment' };

        assert.equal(value(await inputRuntime(input, reconnected)).reason, 'action_acknowledged');
        assert.equal(value(await inputRuntime(input, reconnected)).reason, 'action_acknowledged');
        assert.equal(
          value(await interruptRuntime({ ...request, key: 'interrupt' }, reconnected)).reason,
          'action_acknowledged',
        );
        assert.equal(calls.filter((call) => call.operation === 'input').length, 1);
        assert.equal(calls.filter((call) => call.operation === 'interrupt').length, 1);
        assert.equal(calls.filter((call) => call.operation === 'launch').length, 1);

        const occupant = context.fake.snapshot(ready.session.space.target).agents[0];

        assert.ok(occupant);

        occupant.nativeSessionId = 'later-optional-metadata';

        assert.equal(value(await inspectRuntime(request, reconnected)).state, 'running');

        occupant.nativeSessionId = null;
        modes.input = 'after';
        const uncertain = { ...input, key: 'uncertain-input' };

        assert.equal(value(await inputRuntime(uncertain, reconnected)).reason, 'action_pending');
        assert.equal(value(await inputRuntime(uncertain, reconnected)).reason, 'action_pending');
        assert.equal(
          value(await inputRuntime({ ...uncertain, key: 'replacement' }, reconnected)).reason,
          'action_pending',
        );
        assert.equal(calls.filter((call) => call.operation === 'input').length, 2);
        assert.equal(calls.filter((call) => call.operation === 'launch').length, 1);
      } finally {
        opened.store.close();
      }
    });
  },
);

await test(
  'missing or replaced worker name, kind and terminal block controls even without native IDs',
  options,
  async () => {
    await fixture(async ({ prepare, deps, modes, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      modes.launch = 'missing-native';
      const session = value(await launchRuntime(request, deps)).session;

      assert.ok(session);

      const snapshot = context.fake.snapshot(session.space.target);
      const occupant = snapshot.agents[0];

      assert.ok(occupant);

      const saved = structuredClone(occupant);

      for (const change of [
        { name: null },
        { name: 'replacement-worker' },
        { kind: 'other-agent' },
        { terminalId: 'replacement-terminal' },
      ]) {
        Object.assign(occupant, saved, change);

        assert.equal(value(await inspectRuntime(request, deps)).state, 'unknown');
        assert.equal(
          value(await inputRuntime({ ...request, key: 'unsafe-input', text: 'fixture' }, deps))
            .reason,
          'identity_changed',
        );
        assert.equal(
          value(await interruptRuntime({ ...request, key: 'unsafe-interrupt' }, deps)).reason,
          'identity_changed',
        );
      }

      snapshot.agents.length = 0;

      assert.equal(value(await launchRuntime(request, deps)).state, 'unknown');
      assert.equal(calls.length, 1);
    });
  },
);

for (const hasNativeId of [true, false]) {
  await test(
    `launch-before-handle crash reconnects without relaunch (native ID: ${hasNativeId})`,
    options,
    async () => {
      await fixture(async ({ prepare, deps, modes, calls, context }) => {
        const job = await prepare();
        const request = { schemaVersion: 1, attemptId: job.attempt.id };
        modes.launch = 'after';
        const pending = value(await launchRuntime(request, deps));

        assert.equal(pending.reason, 'launch_pending');
        assert.equal(pending.session?.phase, 'pending');

        if (!hasNativeId) {
          assert.ok(pending.session);

          const occupant = context.fake.snapshot(pending.session.space.target).agents[0];

          assert.ok(occupant);

          occupant.nativeSessionId = null;
        }

        const { openSqliteState } = await import('../src/index.js');
        const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: context.state });

        assert.equal(opened.outcome, 'opened');

        if (opened.outcome !== 'opened') {
          assert.fail('Missing reopened state');
        }

        try {
          const reconnected = value(
            await reconcileRuntime(request, {
              ...deps,
              runtime: opened.runtime,
              herdr: opened.herdr,
            }),
          );

          assert.equal(reconnected.state, 'running');
          assert.equal(reconnected.session?.launchId, pending.session?.launchId);
          assert.equal(calls.length, 1);
        } finally {
          opened.store.close();
        }
      });
    },
  );
}

await test(
  'crash before external launch stays pending even after claims age; absence never authorizes a replacement',
  options,
  async () => {
    await fixture(async ({ prepare, deps, modes, calls }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      modes.launch = 'before';

      assert.equal(value(await launchRuntime(request, deps)).state, 'unknown');

      modes.launch = 'normal';

      assert.equal(value(await launchRuntime(request, deps)).state, 'unknown');
      assert.equal(value(await reconcileRuntime(request, deps)).state, 'unknown');
      assert.equal(calls.length, 1);
    });
  },
);

await test(
  'wrong-pane launch cannot bind and input cannot reach an unverified run',
  options,
  async () => {
    await fixture(async ({ prepare, deps, modes, calls }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      modes.launch = 'wrong-pane';

      assert.equal(value(await launchRuntime(request, deps)).state, 'unknown');
      assert.equal(
        value(await inputRuntime({ ...request, key: 'prompt', text: 'fixture' }, deps)).state,
        'blocked',
      );
      assert.equal(calls.length, 1);
    });
  },
);

await test(
  'input is keyed, acknowledged separately from work completion, and interrupts never claim shutdown',
  options,
  async () => {
    await fixture(async ({ prepare, deps, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      const session = value(await launchRuntime(request, deps)).session;

      assert.ok(session);

      const input = { ...request, key: 'first-input', text: 'fixture private text; $(literal)' };

      assert.equal(value(await inputRuntime(input, deps)).action?.state, 'acknowledged');
      assert.equal(value(await inputRuntime(input, deps)).reason, 'action_acknowledged');

      const conflict = await inputRuntime({ ...input, text: 'different' }, deps);

      assert.ok(conflict.outcome === 'rejected' && conflict.error.code === 'runtime_conflict');
      assert.equal(calls.filter((call) => call.operation === 'input').length, 1);

      const persisted = deps.runtime.action(job.attempt.id, input.key);

      assert.equal(JSON.stringify(persisted).includes(input.text), false);

      const occupant = context.fake.snapshot(session.space.target).agents[0];

      assert.ok(occupant);

      occupant.status = 'working';

      assert.equal(value(await inputRuntime({ ...input, key: 'busy' }, deps)).reason, 'agent_busy');
      assert.equal(
        value(await interruptRuntime({ ...request, key: 'interrupt' }, deps)).reason,
        'action_acknowledged',
      );
      assert.equal(
        value(await interruptRuntime({ ...request, key: 'interrupt' }, deps)).reason,
        'action_acknowledged',
      );
      assert.equal(calls.filter((call) => call.operation === 'interrupt').length, 1);

      for (const state of ['idle', 'blocked', 'done'] as const) {
        occupant.status = state;

        assert.equal(value(await inspectRuntime(request, deps)).state, 'running');
      }

      const attempt = deps.state.inspectRecord({
        schemaVersion: 1,
        entity: 'attempt',
        id: job.attempt.id,
      });

      assert.ok(
        attempt.outcome === 'completed' &&
          attempt.value?.entity === 'attempt' &&
          attempt.value.resolvedAt === null,
      );
    });
  },
);

await test(
  'lost input acknowledgement retains one pending action and never resends based on idle state',
  options,
  async () => {
    await fixture(async ({ prepare, deps, modes, calls }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      await launchRuntime(request, deps);
      modes.input = 'after';
      const input = { ...request, key: 'input', text: 'fixture task' };

      assert.equal(value(await inputRuntime(input, deps)).state, 'unknown');
      assert.equal(value(await inputRuntime(input, deps)).state, 'unknown');
      assert.equal(
        value(await inputRuntime({ ...input, key: 'replacement' }, deps)).reason,
        'action_pending',
      );
      assert.equal(value(await reconcileRuntime(request, deps)).reason, 'action_pending');
      assert.equal(calls.filter((call) => call.operation === 'input').length, 1);
      assert.equal(
        JSON.stringify(await inputRuntime(input, deps)).includes('fixture-private'),
        false,
      );
    });
  },
);

await test(
  'changed native session, terminal, server epoch, cwd and approval dialog block control without fallback',
  options,
  async () => {
    await fixture(async ({ prepare, deps, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      const session = value(await launchRuntime(request, deps)).session;

      assert.ok(session);

      const snapshot = context.fake.snapshot(session.space.target);
      const occupant = snapshot.agents[0];
      const pane = snapshot.panes.find((pane) => pane.paneId === session.space.handle?.paneId);

      assert.ok(occupant && pane);

      occupant.status = 'blocked';

      assert.equal(
        value(await inputRuntime({ ...request, key: 'approval', text: 'y' }, deps)).reason,
        'agent_blocked',
      );
      assert.equal(
        value(await interruptRuntime({ ...request, key: 'approval-interrupt' }, deps)).reason,
        'agent_blocked',
      );

      occupant.status = 'idle';
      const saved = structuredClone(occupant);
      occupant.nativeSessionId = 'replacement-session';

      assert.equal(value(await inspectRuntime(request, deps)).state, 'unknown');
      assert.equal(
        value(await inputRuntime({ ...request, key: 'changed', text: 'fixture' }, deps)).reason,
        'identity_changed',
      );

      occupant.nativeSessionId = null;

      assert.equal(value(await inspectRuntime(request, deps)).state, 'unknown');
      assert.equal(
        value(await interruptRuntime({ ...request, key: 'missing-native' }, deps)).reason,
        'identity_changed',
      );

      Object.assign(occupant, saved);
      pane.terminalId = 'replacement-terminal';

      assert.equal(value(await inspectRuntime(request, deps)).state, 'unknown');

      pane.terminalId = saved.terminalId;
      occupant.foregroundCwd = context.sources[1] ?? '';

      assert.equal(value(await inspectRuntime(request, deps)).state, 'unknown');

      Object.assign(occupant, saved);
      snapshot.server.inode = '999999';

      assert.equal(value(await reconcileRuntime(request, deps)).state, 'unknown');
      assert.equal(calls.length, 1);
    });
  },
);

await test(
  'revoked policy, missing capability, malformed requests and cancellation cannot launch workers',
  options,
  async () => {
    await fixture(async ({ prepare, deps, policy, calls, context }) => {
      const queued = await context.worker('queued');
      const queuedRequest = { schemaVersion: 1, attemptId: queued.attempt.id };

      assert.equal((await launchRuntime(queuedRequest, deps)).outcome, 'rejected');

      const job = await prepare('claimed');
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      const controller = new AbortController();
      controller.abort();
      const cancelled = await launchRuntime(request, deps, controller.signal);

      assert.ok(cancelled.outcome === 'rejected' && cancelled.error.code === 'cancelled');

      const invalid = await launchRuntime({ ...request, schemaVersion: 2 }, deps);

      assert.ok(
        invalid.outcome === 'rejected' && invalid.error.code === 'unsupported_contract_version',
      );

      const executableMismatch = await launchRuntime(request, {
        ...deps,
        canonicalCodexExecutable: '/wrong/codex',
      });

      assert.ok(
        executableMismatch.outcome === 'rejected' &&
          executableMismatch.error.code === 'configuration_blocked',
      );

      await policy((value) => {
        value.execution.enabled = false;
      });
      const revoked = await launchRuntime(request, deps);

      assert.ok(revoked.outcome === 'rejected' && revoked.error.code === 'configuration_blocked');
      assert.equal(calls.length, 0);
    });
  },
);

await test(
  'unsupported native arguments and required hooks block instead of being silently ignored',
  options,
  async () => {
    await fixture(async ({ prepare, deps, policy, calls, context }) => {
      await policy((value) => {
        value.execution.commands['fixture-worker'].args = [
          '--dangerously-bypass-approvals-and-sandbox',
        ];
      });
      const first = await prepare('unsafe');
      const result = await launchRuntime({ schemaVersion: 1, attemptId: first.attempt.id }, deps);

      assert.ok(
        result.outcome === 'rejected' && result.error.code === 'runtime_capability_missing',
      );

      await policy((value) => {
        value.execution.commands['fixture-worker'].args = nativeArgs;
        value.project.hooks = { setup: 'fixture-worker' };
      });
      const second = await context.worker('required-hook');
      const claim = context.opened.service.claim({
        jobId: second.job.id,
        owner: 'fixture-service',
        token: 'required-hook-claim',
        now: 1000,
        limits: { global: 4, defaultRole: 4, perRole: {} },
      });

      assert.ok(claim.outcome === 'persisted' && claim.value === null);

      const prerequisites = context.opened.hooks.prerequisitesReady(second.job.id);

      assert.ok(prerequisites.outcome === 'completed' && !prerequisites.value);
      assert.equal(calls.length, 0);
    });
  },
);

await test(
  'service runtime starts a session, recovers by inspection and retains capacity despite UI done',
  options,
  async () => {
    await fixture(async ({ deps, context, calls }) => {
      const queued = await context.worker();
      const runtime = createCodexHerdrRuntime(deps);
      const coordinator = createServiceCoordinator({
        sessionId: 'runtime-service',
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [runtime],
        dependencies: {
          ...context.deps,
          queue: context.opened.service,
          now: () => 1000,
          nextId: (kind) => `${kind}-runtime`,
        },
        onFailure: () => assert.fail('Coordinator failed'),
      });
      coordinator.start();

      try {
        await coordinator.idle();
        const saved = deps.queue.read(queued.job.id);

        assert.ok(
          saved.outcome === 'completed' && saved.value?.entry.state === 'started',
          JSON.stringify(saved),
        );

        const session = deps.runtime.read(queued.attempt.id);

        assert.ok(session.outcome === 'completed' && session.value);

        const occupant = context.fake.snapshot(session.value.space.target).agents[0];

        assert.ok(occupant);

        occupant.status = 'done';
        coordinator.wake();
        await coordinator.idle();
        const fresh = deps.queue.read(queued.job.id);

        assert.ok(fresh.outcome === 'completed' && fresh.value?.entry.state === 'started');
        assert.equal(calls.length, 1);
      } finally {
        await coordinator.stop();
      }
    });
  },
);

await test(
  'compiled CLI exposes capabilities and reads a missing runtime from neutral cwd without launching a provider',
  options,
  async () => {
    await fixture(async ({ context }) => {
      const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
      const run = (args: string[]) =>
        spawnSync(process.execPath, [cli, '--state-directory', context.state, ...args], {
          cwd: context.root,
          encoding: 'utf8',
          timeout: 15_000,
        });
      const capabilities = run(['runtime', 'capabilities']);

      assert.equal(capabilities.status, 0, capabilities.stderr);
      assert.deepEqual(JSON.parse(capabilities.stdout), runtimeCapabilities);

      const inspected = run(['runtime', 'inspect', '--attempt', 'absent', '--json']);

      assert.equal(inspected.status, 0, inspected.stderr);
      assert.equal(
        value(runtimeResultSchema.parse(JSON.parse(inspected.stdout))).state,
        'not_started',
      );
    });
  },
);

function execution(body: unknown): ProcessResult {
  const text = JSON.stringify(body);
  const output = (text: string) => ({
    text,
    capturedBytes: Buffer.byteLength(text),
    observedBytes: Buffer.byteLength(text),
    complete: true,
    truncated: false,
    artifact: null,
  });

  return {
    schemaVersion: 1,
    outcome: 'exited',
    pid: 123,
    exitCode: 0,
    signal: null,
    error: null,
    stdout: output(text),
    stderr: output(''),
    shutdown: { root: 'exited', processGroup: 'absent', termSent: false, killSent: false },
  };
}

for (const sessionEvidence of ['id', 'null', 'omitted'] as const) {
  await test(
    `Herdr control adapter uses verified agent names with ${sessionEvidence} native evidence`,
    options,
    async () => {
      await fixture(async ({ prepare, deps }) => {
        const job = await prepare();
        const launched = value(
          await launchRuntime({ schemaVersion: 1, attemptId: job.attempt.id }, deps),
        ).session;

        assert.ok(launched?.agent && launched.space.handle);

        const space = { ...launched.space, agent: launched.agent };

        assert.ok(space.handle);

        const requests: ProcessRequest[] = [];
        let native = sessionEvidence === 'id' ? launched.agent.nativeSessionId : null;
        space.agent = { ...launched.agent, nativeSessionId: native };
        let agentName: string | null = space.expectedAgentName;
        let terminalId = space.handle.terminalId;
        let starting = false;
        let agentStatus: 'idle' | 'working' | 'blocked' = 'idle';
        const provider = createHerdrCliProvider({
          executable: '/fixture/herdr',
          endpoint: {
            async read() {
              const { protocol: _protocol, ...server } = space.server;

              return server;
            },
          },
          runner: {
            async run(request) {
              requests.push(processRequestSchema.parse(request));

              if (request.args[0] === 'api') {
                const handle = space.handle;

                assert.ok(handle);

                const pane = {
                  workspace_id: handle.workspaceId,
                  tab_id: handle.tabId,
                  pane_id: handle.paneId,
                  terminal_id: handle.terminalId,
                  cwd: space.root,
                  foreground_cwd: space.root,
                };

                return execution({
                  result: {
                    type: 'session_snapshot',
                    snapshot: {
                      protocol: 22,
                      workspaces: [{ workspace_id: handle.workspaceId, label: 'worker' }],
                      tabs: [{ workspace_id: handle.workspaceId, tab_id: handle.tabId }],
                      panes: [pane],
                      agents: starting
                        ? []
                        : [
                            {
                              ...pane,
                              name: agentName,
                              terminal_id: terminalId,
                              agent: 'codex',
                              agent_status: agentStatus,
                              agent_session:
                                sessionEvidence === 'omitted'
                                  ? undefined
                                  : native === null
                                    ? null
                                    : { kind: 'id', value: native },
                            },
                          ],
                    },
                  },
                });
              }

              return execution({
                result: {
                  type:
                    request.args[1] === 'start'
                      ? 'agent_started'
                      : request.args[1] === 'prompt'
                        ? 'agent_prompted'
                        : 'ok',
                },
              });
            },
          },
        });
        const text = 'literal; $(not-a-command)\nsecond line';

        assert.equal((await provider.input(space, text)).outcome, 'completed');
        assert.deepEqual(requests[1]?.args, ['agent', 'prompt', space.expectedAgentName, text]);
        assert.equal((await provider.interrupt(space)).outcome, 'completed');
        assert.deepEqual(requests[3]?.args, ['agent', 'send-keys', space.expectedAgentName, 'esc']);

        if (sessionEvidence === 'id') {
          native = 'replacement';
        } else {
          agentName = 'replacement-worker';
        }

        assert.equal((await provider.input(space, text)).outcome, 'rejected');
        assert.equal(requests.length, 5);

        native = space.agent.nativeSessionId;
        agentName = space.expectedAgentName;
        agentStatus = 'blocked';

        assert.equal((await provider.interrupt(space)).outcome, 'rejected');
        assert.equal(requests.length, 6);

        agentStatus = 'working';

        assert.equal((await provider.input(space, text)).outcome, 'rejected');
        assert.equal(requests.length, 7);

        starting = true;

        assert.equal(
          (
            await provider.launch({
              space: { ...space, agent: null },
              args: nativeArgs,
              timeoutMs: 30_000,
            })
          ).outcome,
          'completed',
        );
        assert.deepEqual(requests[8]?.args, [
          'agent',
          'start',
          space.expectedAgentName,
          '--kind',
          'codex',
          '--pane',
          space.handle.paneId,
          '--timeout',
          '29000',
          '--',
          ...nativeArgs,
          '-c',
          'check_for_update_on_startup=false',
          '--cd',
          space.root,
        ]);
        assert.equal(requests[8]?.timeoutMs, 30_000);

        starting = false;
        agentStatus = 'idle';
        agentName = null;

        assert.equal((await provider.input(space, text)).outcome, 'rejected');

        agentName = space.expectedAgentName;
        terminalId = 'replacement-terminal';

        assert.equal((await provider.input(space, text)).outcome, 'rejected');
        assert.equal((await provider.interrupt(space)).outcome, 'rejected');
        assert.equal(requests.filter((request) => request.args[0] === 'agent').length, 3);
      });
    },
  );
}
