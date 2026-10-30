import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCodexLaunchValidator,
  nodeProcessRunner,
  processRequestSchema,
  launchRuntime,
  reconcileRuntime,
  inputRuntime,
  inspectRuntime,
  type RuntimeLaunchValidationInput,
  type RuntimePaneProbe,
} from '../src/index.js';
import { completed, rejected } from '../src/contracts/operation-result.js';
import { fixture, nativeArgs } from './support/runtime.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const options = { timeout: 90_000 };
async function adapterFixture(
  action: (f: {
    input: RuntimeLaunchValidationInput;
    environment: Record<string, string>;
    configuration: string;
    make: (pane?: RuntimePaneProbe) => ReturnType<typeof createCodexLaunchValidator>;
    runPane: RuntimePaneProbe['probe'];
  }) => Promise<void>,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "astack-profile-'")));

  try {
    const bin = join(directory, 'bin');
    const home = join(directory, 'home');
    const root = join(directory, 'repository');
    await Promise.all([mkdir(bin), mkdir(home), mkdir(root)]);
    const executable = join(bin, 'codex');
    const configuration = join(home, 'config.toml');
    await writeFile(configuration, 'model = "authored-model"\n');
    const program = `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('codex fixture-1');process.exit(0);}
if(args.includes('--help')) {
  if(args[args.indexOf('--model')+1] !== 'test-model' ||
    !args.includes('model_reasoning_effort="high"') ||
    !args.includes('check_for_update_on_startup=false') ||
    args[args.indexOf('--cd')+1] !== process.cwd()) process.exit(4);
  console.log('--sandbox --ask-for-approval --no-daemon --no-alt-screen --model --config --cd');
  process.exit(0);
}
if(args.includes('features') && args.includes('list')) {
  const required=['model="test-model"','model_reasoning_effort="high"',
    'sandbox_mode="workspace-write"','approval_policy="on-request"',
    'check_for_update_on_startup=false'];
  if(!required.every(value=>args.includes(value))) process.exit(5);
  const text=fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8');
  if(text.includes('INVALID')) process.exit(2);
  console.log('private-provider-diagnostic');
  process.exit(0);
}
process.exit(3);
`;
    await writeFile(executable, program, { mode: 0o700 });
    const environment = { HOME: home, CODEX_HOME: home, PATH: bin };
    // The validator needs only saved pane provenance from this fixture's actual owned layout.
    await fixture(async ({ prepare, deps }) => {
      const job = await prepare();
      const { prepareHerdrWorker } = await import('../src/application/herdr.js');
      const layout = await prepareHerdrWorker(
        { schemaVersion: 1, attemptId: job.attempt.id },
        deps,
      );

      assert.ok('record' in layout && layout.record);

      const input: RuntimeLaunchValidationInput = {
        profile: {
          runtime: 'codex-herdr',
          settings: {
            schemaVersion: 1,
            model: 'test-model',
            reasoning: 'high',
            executableDigest: hash(program),
            version: 'codex fixture-1',
            ambientEnvironmentApproved: true,
            shellResolutionApproved: true,
            environment,
            files: { [configuration]: hash(await readFile(configuration)) },
          },
        },
        executable,
        args: nativeArgs,
        space: { ...layout.record, root },
        invocationId: 'validation-fixture',
        timeoutMs: 5000,
      };
      const runPane: RuntimePaneProbe['probe'] = async (request, signal) => {
        const execution = await nodeProcessRunner.run(
          processRequestSchema.parse({
            schemaVersion: 1,
            executable: request.executable,
            args: ['-e', request.program],
            cwd: root,
            env: environment,
            timeoutMs: request.timeoutMs,
            maxCaptureBytes: 4096,
          }),
          signal,
        );

        assert.equal(execution.outcome, 'exited', JSON.stringify(execution));

        return execution.outcome === 'exited'
          ? completed(execution.stdout.text)
          : rejected('runtime_unavailable', 'Fixture probe failed.');
      };

      const make = (pane: RuntimePaneProbe = { probe: runPane }) =>
        createCodexLaunchValidator({
          runner: nodeProcessRunner,
          pane,
          nodeExecutable: process.execPath,
          environment,
        });
      await action({ input, configuration, environment, make, runPane });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test(
  'installed-agent host and pane validation pins settings without rewriting authored files',
  options,
  async () => {
    await adapterFixture(async ({ input, configuration, make }) => {
      const original = await readFile(configuration, 'utf8');
      const validator = make();
      const result = await validator.validate(input);

      assert.equal(result.outcome, 'completed', JSON.stringify(result));

      if (result.outcome !== 'completed') {
        assert.fail('Missing evidence');
      }

      assert.deepEqual(result.value.args, [
        ...nativeArgs,
        '--model',
        'test-model',
        '-c',
        'model_reasoning_effort="high"',
      ]);
      assert.match(result.value.contextDigest, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(result).includes('private-provider-diagnostic'), false);
      assert.deepEqual(await validator.inspect(input), completed(result.value));
      assert.equal(await readFile(configuration, 'utf8'), original);
    });
  },
);

await test(
  'configuration precedence, executable identity, version and host/pane environment drift block validation',
  options,
  async () => {
    await adapterFixture(async ({ input, configuration, environment, make, runPane }) => {
      let probes = 0;
      const counted = make({
        async probe(request, signal) {
          probes++;

          return runPane(request, signal);
        },
      });
      const settings = structuredClone(input.profile.settings);

      for (const change of [
        { executableDigest: '0'.repeat(64) },
        { version: 'stale-version' },
        { environment: { ...environment, HOME: '/wrong-home' } },
        { unknownConfigOverride: true },
      ]) {
        assert.equal(
          (
            await counted.validate({
              ...input,
              profile: { ...input.profile, settings: { ...settings, ...change } },
            })
          ).outcome,
          'rejected',
        );
      }

      assert.equal(probes, 0);

      const local = join(input.space.root, '.codex');
      await mkdir(local);
      const file = join(local, 'config.toml');
      await writeFile(file, 'model = "higher-precedence"\n');

      assert.equal((await counted.validate(input)).outcome, 'rejected');
      assert.equal(probes, 0);

      const approved = {
        ...input,
        profile: {
          ...input.profile,
          settings: {
            ...settings,
            files: {
              [configuration]: hash(await readFile(configuration)),
              [file]: hash(await readFile(file)),
            },
          },
        },
      };

      assert.equal((await counted.validate(approved)).outcome, 'completed');

      await writeFile(configuration, 'INVALID');
      const invalid = {
        ...approved,
        profile: {
          ...approved.profile,
          settings: {
            ...approved.profile.settings,
            files: {
              [configuration]: hash('INVALID'),
              [file]: hash(await readFile(file)),
            },
          },
        },
      };

      assert.equal((await counted.validate(invalid)).outcome, 'rejected');

      await writeFile(configuration, 'model = "authored-model"\n');
      const differentPane = make({
        async probe(request, signal) {
          const changed = request.program.replace(
            'const p=JSON.parse',
            'process.env.HOME="/different-pane-home";const p=JSON.parse',
          );

          return runPane({ ...request, program: changed }, signal);
        },
      });

      assert.equal((await differentPane.validate(approved)).outcome, 'rejected');
    });
  },
);

await test(
  'missing, stale, duplicate, failed and uncertain pane markers never become launch evidence',
  options,
  async () => {
    await adapterFixture(async ({ input, configuration, make, runPane }) => {
      for (const mode of [
        'missing',
        'stale',
        'duplicate',
        'padded-duplicate',
        'failed',
        'different',
        'timeout',
        'changed',
      ]) {
        let probes = 0;
        const validator = make({
          async probe(request, signal) {
            probes++;
            const response = await runPane(request, signal);

            assert.equal(response.outcome, 'completed');

            if (response.outcome !== 'completed') {
              return response;
            }

            if (mode === 'missing') {
              return completed('no completion marker');
            }

            if (mode === 'stale') {
              return completed(response.value.replaceAll(request.marker, 'ASTACK_OLD'));
            }

            if (mode === 'duplicate') {
              return completed(response.value + response.value);
            }

            if (mode === 'padded-duplicate') {
              return completed(response.value + '  ' + response.value);
            }

            if (mode === 'failed') {
              return completed(request.marker + ':1\n');
            }

            if (mode === 'different') {
              return completed(request.marker + ':0:' + 'b'.repeat(64) + '\n');
            }

            if (mode === 'timeout') {
              return rejected('runtime_unavailable', 'Fixture timeout.');
            }

            await writeFile(configuration, 'model = "changed-after-pane"\n');

            return response;
          },
        });

        assert.equal((await validator.validate(input)).outcome, 'rejected', mode);
        assert.equal(probes, 1);
      }
    });
  },
);

await test(
  'validation intent precedes pane effects and failures never replay or bind an unexpected worker',
  options,
  async () => {
    await fixture(async ({ prepare, deps, calls, context }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      let validations = 0;
      const validator = deps.launchValidator;

      assert.ok(validator);

      deps.launchValidator = {
        ...validator,
        async validate(input) {
          validations++;
          const saved = deps.runtime.read(job.attempt.id);

          assert.ok(saved.outcome === 'completed' && saved.value?.validation?.state === 'pending');
          assert.equal(saved.value.validation.invocationId, input.invocationId);
          assert.equal(calls.length, 0);

          return rejected('runtime_capability_missing', 'Fixture rejected configuration.');
        },
      };
      const result = await launchRuntime(request, deps);

      assert.ok(result.outcome === 'completed' && result.value.reason === 'launch_pending');

      const space = context.opened.herdr.worker(job.attempt.id);

      assert.ok(space.outcome === 'completed' && space.value?.handle);

      context.fake.snapshot(space.value.target).agents.push({
        ...space.value.handle,
        name: space.value.expectedAgentName,
        kind: 'codex',
        nativeSessionId: 'unrelated',
        cwd: space.value.root,
        foregroundCwd: space.value.root,
        status: 'idle',
      });
      await launchRuntime(request, deps);
      const reconciled = await reconcileRuntime(request, deps);

      assert.ok(
        reconciled.outcome === 'completed' && reconciled.value.session?.phase === 'pending',
      );
      assert.equal(validations, 1);
      assert.equal(calls.length, 0);
    });
  },
);

await test(
  'profile, host context and adapter argument drift preserve a running worker but block reuse and new input',
  options,
  async () => {
    await fixture(async ({ prepare, deps, calls }) => {
      const job = await prepare();
      const request = { schemaVersion: 1, attemptId: job.attempt.id };
      const started = await launchRuntime(request, deps);

      assert.ok(
        started.outcome === 'completed' && started.value.session?.validation?.state === 'validated',
      );

      const saved = deps.launchValidator;

      assert.ok(saved);

      for (const change of [
        { args: nativeArgs, contextDigest: 'b'.repeat(64) },
        { args: [...nativeArgs, '--model', 'changed'], contextDigest: 'a'.repeat(64) },
      ]) {
        deps.launchValidator = {
          ...saved,
          async inspect() {
            return completed(change);
          },
        };
        const inspection = await inspectRuntime(request, deps);
        const input = await inputRuntime(
          { ...request, key: 'drifted-input', text: 'must not deliver' },
          deps,
        );

        assert.ok(
          inspection.outcome === 'completed' && inspection.value.reason === 'policy_blocked',
        );
        assert.ok(input.outcome === 'completed' && input.value.reason === 'policy_blocked');

        await launchRuntime(request, deps);
      }

      assert.equal(calls.filter((call) => call.operation === 'launch').length, 1);
      assert.equal(calls.filter((call) => call.operation === 'input').length, 0);
    });
  },
);

await test(
  'Herdr pane probe quotes its fixed loader, reads the exact target and rejects moved or incomplete panes',
  options,
  async () => {
    const { createHerdrCliProvider, processResultSchema } = await import('../src/index.js');
    await fixture(async ({ prepare, deps }) => {
      const job = await prepare();
      const { prepareHerdrWorker } = await import('../src/application/herdr.js');
      const layout = await prepareHerdrWorker(
        { schemaVersion: 1, attemptId: job.attempt.id },
        deps,
      );

      assert.ok('record' in layout && layout.record?.handle);

      const space = layout.record;
      const handle = space.handle;

      assert.ok(handle);

      let output = '';
      let terminal = handle.terminalId;
      let source = 'recent-unwrapped';
      let truncated = false;
      let mode = 'normal';
      let probes = 0;
      const execution = (body: unknown) => {
        const text = JSON.stringify(body);
        const stream = (value: string) => ({
          text: value,
          capturedBytes: Buffer.byteLength(value),
          observedBytes: Buffer.byteLength(value),
          truncated: false,
          complete: true,
          artifact: null,
        });

        return processResultSchema.parse({
          schemaVersion: 1,
          outcome: 'exited',
          pid: 123,
          exitCode: 0,
          signal: null,
          error: null,
          stdout: stream(text),
          stderr: stream(''),
          shutdown: { root: 'exited', processGroup: 'absent', termSent: false, killSent: false },
        });
      };

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
            if (request.args[0] === 'api') {
              return execution({
                result: {
                  type: 'session_snapshot',
                  snapshot: {
                    protocol: 22,
                    workspaces: [{ workspace_id: handle.workspaceId, label: 'worker' }],
                    tabs: [{ workspace_id: handle.workspaceId, tab_id: handle.tabId }],
                    panes: [
                      {
                        workspace_id: handle.workspaceId,
                        tab_id: handle.tabId,
                        pane_id: handle.paneId,
                        terminal_id: terminal,
                        cwd: space.root,
                        foreground_cwd: space.root,
                      },
                    ],
                    agents: [],
                  },
                },
              });
            }

            if (request.args[1] === 'run') {
              probes++;

              assert.equal(request.args[2], handle.paneId);

              const command = request.args[3];

              assert.ok(command);
              assert.equal(command.includes('shell-injection'), false);

              const result = await nodeProcessRunner.run(
                processRequestSchema.parse({
                  schemaVersion: 1,
                  executable: '/bin/sh',
                  args: ['-c', command],
                  cwd: space.root,
                  env: {},
                  timeoutMs: 5000,
                  maxCaptureBytes: 4096,
                }),
              );

              assert.ok(
                result.outcome === 'exited' && result.exitCode === 0,
                JSON.stringify(result),
              );

              output = result.stdout.text;

              if (mode === 'moved') {
                terminal = 'replacement-terminal';
              }

              if (mode === 'timeout') {
                output = 'stale output';
              }

              return execution({ result: { type: 'ok' } });
            }

            return execution({
              result: {
                type: 'pane_read',
                read: {
                  pane_id: handle.paneId,
                  tab_id: handle.tabId,
                  workspace_id: handle.workspaceId,
                  revision: 1,
                  source,
                  format: 'text',
                  truncated,
                  text: output,
                },
              },
            });
          },
        },
      });
      const marker = 'ASTACK_TEST_NONCE';
      const input = {
        space,
        executable: process.execPath,
        program: `console.log('${marker}:0:'+'a'.repeat(64)); // shell-injection ' $()`,
        marker,
        timeoutMs: 1000,
      };
      const passed = await provider.probe(input);

      assert.equal(passed.outcome, 'completed', JSON.stringify(passed));
      assert.equal(probes, 1);

      const failed = await provider.probe({
        ...input,
        program: input.program + '\nprocess.exitCode=1;',
      });

      assert.equal(failed.outcome, 'rejected');

      const duplicated = await provider.probe({
        ...input,
        program: input.program + `\nconsole.log('${marker}_EXIT:0');`,
      });

      assert.equal(duplicated.outcome, 'rejected');

      for (const failure of ['truncated', 'source', 'moved', 'timeout']) {
        truncated = failure === 'truncated';
        source = failure === 'source' ? 'visible' : 'recent-unwrapped';
        mode = failure;
        terminal = handle.terminalId;

        assert.equal((await provider.probe(input)).outcome, 'rejected', failure);
      }

      assert.equal(probes, 7);
    });
  },
);

await test(
  'missing profiles, cancelled probes and policy changes cannot authorize native startup',
  options,
  async () => {
    for (const mode of ['missing', 'cancelled', 'policy']) {
      await fixture(async ({ prepare, deps, policy, calls }) => {
        if (mode === 'missing') {
          await policy((value) => {
            delete value.execution.launchProfiles;
          });
        }

        const job = await prepare();
        const request = { schemaVersion: 1, attemptId: job.attempt.id };
        const original = deps.launchValidator;

        assert.ok(original);

        const controller = new AbortController();
        let probes = 0;
        deps.launchValidator = {
          ...original,
          async validate(input, signal) {
            probes++;

            if (mode === 'cancelled') {
              controller.abort();
            }

            if (mode === 'policy') {
              await policy((value) => {
                value.execution.enabled = false;
              });
            }

            return original.validate(input, signal);
          },
        };
        const result = await launchRuntime(request, deps, controller.signal);

        assert.equal(calls.length, 0, JSON.stringify(result));
        assert.equal(probes, mode === 'missing' ? 0 : 1);

        await launchRuntime(request, deps);

        assert.equal(calls.length, 0);
        assert.equal(probes, mode === 'missing' ? 0 : 1);
      });
    }
  },
);
