import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './support/implementation.js';
import { git } from './support/service.js';
import {
  executeHook,
  excludeHookWriter,
  reconcileHook,
  hookExecutionResultSchema,
  hookRecordSchema,
  hostConfigurationPolicySchema,
  submitImplementation,
  submitReview,
  reviewSubmitRequestSchema,
  reserveAllocation,
  confirmAllocationRunning,
  releaseAllocation,
  createReviewRuntime,
  nodeProcessRunner,
  acquireCoordinatorOwnership,
  type HostConfigurationPolicy,
  type HookDependencies,
  type HookRequest,
  type HookRecord,
  type ServiceJob,
  type AllocationRecord,
  type StateWriteResult,
  type ReviewDependencies,
  type ReviewSnapshot,
} from '../src/index.js';
import { completed } from '../src/contracts/operation-result.js';
const options = { timeout: 180000 };
type Context = Parameters<Parameters<typeof fixture>[0]>[0];
const secret = 'fixture-private-value-never-store';
function hook(result: Awaited<ReturnType<typeof executeHook>>) {
  hookExecutionResultSchema.parse(result);

  assert.equal(result.outcome, 'persisted', JSON.stringify(result));

  if (result.outcome !== 'persisted') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

function allocation(result: StateWriteResult<AllocationRecord>) {
  assert.equal(result.outcome, 'persisted', JSON.stringify(result));

  if (result.outcome !== 'persisted') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

async function profile(
  f: Context,
  index: number,
  phases: ('setup' | 'verify' | 'start' | 'teardown')[] = ['verify'],
  resources = false,
  script?: string,
  edit?: (policy: HostConfigurationPolicy) => void,
) {
  const request = await f.prepare(index, `hooks-${index}`);
  const path = join(f.context.state, 'config', `project-${index}.json`);
  const policy = hostConfigurationPolicySchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const variable = index === 0 ? 'NODE_PROFILE' : 'PYTHON_PROFILE';
  const resourceVariable = index === 0 ? 'APP_PORT' : 'WEB_PORT';
  policy.execution.allowedEnvironment = [variable, 'TEST_SECRET', resourceVariable];
  policy.execution.hooks = {};
  policy.project.hooks = { setup: null, verify: null, teardown: null };

  for (const phase of phases) {
    const command = `hook-${phase}`;
    policy.project.hooks[phase] = command;
    policy.execution.hooks[phase] = {
      command,
      timeoutMs: 1000,
      environment: [variable, 'TEST_SECRET'],
      resources: resources ? { [resourceVariable]: { key: 'api', field: 'port' } } : {},
    };
    policy.execution.commands[command] = {
      executable: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        script ??
          `import {writeFileSync} from 'node:fs'; writeFileSync('${phase}.json', JSON.stringify({cwd:process.cwd(),profile:process.env.${variable},port:process.env.${resourceVariable}??null,ambient:process.env.HOME??null}));console.log(process.env.TEST_SECRET);`,
      ],
    };
  }

  edit?.(policy);
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  const submitted = await submitImplementation(request, f.deps);

  assert.ok(submitted.outcome === 'persisted', JSON.stringify(submitted));

  const deps: HookDependencies = {
    ...f.deps,
    hooks: f.context.opened.hooks,
    allocations: f.context.opened.allocations,
    ports: { inspect: async () => completed('free') },
    runner: nodeProcessRunner,
    environment: {
      read: async (names) =>
        completed(
          Object.fromEntries(
            names.map((name) => [
              name,
              name === 'TEST_SECRET' ? secret : index === 0 ? 'node' : 'python',
            ]),
          ),
        ),
    },
  };

  return { request, job: submitted.value.job, deps, path, policy };
}

function request(
  job: ServiceJob,
  phase: HookRequest['phase'],
  key: string = phase,
  allocations: AllocationRecord[] = [],
): HookRequest {
  return {
    schemaVersion: 1,
    jobId: job.job.id,
    attemptId: job.attempt.id,
    key,
    phase,
    commit: job.attempt.commit,
    allocations: allocations.map((a) => ({ id: a.id, expectedRevision: a.revision })),
    writersExcluded: true,
  };
}

function shutdown(record: HookRecord) {
  return {
    schemaVersion: 1,
    id: record.id,
    expectedRevision: record.revision,
    key: 'shutdown',
    writersStopped: true as const,
    servicesStopped: true as const,
  };
}

await test(
  'two technology profiles execute literal approved commands in isolated checkouts without persisting environment/output',
  options,
  async () => {
    await fixture(async (f) => {
      const a = await profile(f, 0, ['setup', 'verify']);
      const b = await profile(f, 1, ['setup', 'verify']);
      const before = f.context.opened.hooks.prerequisitesReady(a.job.job.id);

      assert.ok(before.outcome === 'completed' && !before.value);

      const [one, two] = await Promise.all([
        executeHook(request(a.job, 'setup'), a.deps),
        executeHook(request(b.job, 'setup'), b.deps),
      ]);
      const first = hook(one),
        second = hook(two);

      assert.equal(first.status, 'succeeded');
      assert.equal(second.status, 'succeeded');

      const firstOutput: unknown = JSON.parse(
        await readFile(join(first.root, 'setup.json'), 'utf8'),
      );
      const secondOutput: unknown = JSON.parse(
        await readFile(join(second.root, 'setup.json'), 'utf8'),
      );

      assert.deepEqual(firstOutput, {
        cwd: first.root,
        profile: 'node',
        port: null,
        ambient: null,
      });
      assert.deepEqual(secondOutput, {
        cwd: second.root,
        profile: 'python',
        port: null,
        ambient: null,
      });
      assert.ok(!JSON.stringify([first, second]).includes(secret));
      assert.ok(first.result && first.result.stdout.observedBytes > 0);
      assert.equal(first.result?.shutdown.processGroup, 'absent');

      const ready = f.context.opened.hooks.prerequisitesReady(a.job.job.id);

      assert.ok(ready.outcome === 'completed' && ready.value);

      const stateless = hook(await executeHook(request(a.job, 'setup'), a.deps));

      assert.equal(stateless.revision, first.revision);

      const verified = hook(await executeHook(request(a.job, 'verify'), a.deps));

      assert.equal(verified.status, 'succeeded');

      const bypass = f.context.opened.store.releaseResource({
        schemaVersion: 1,
        resourceId: first.id,
        attemptId: a.job.attempt.id,
        evidence: { stopped: true },
      });

      assert.equal(bypass.outcome, 'rejected');
      assert.equal(reconcileHook(shutdown(first), a.deps).outcome, 'persisted');
      assert.equal(reconcileHook(shutdown(first), a.deps).outcome, 'persisted');
    });
  },
);
await test(
  'missing hooks, changed proposals/policy, stale SHA, wrong resources and invalid/cancelled requests launch nothing',
  options,
  async () => {
    await fixture(async (f) => {
      const p = await profile(f, 0, ['verify']);
      let calls = 0;
      const deps = {
        ...p.deps,
        runner: {
          run: async (...args: Parameters<typeof nodeProcessRunner.run>) => {
            calls++;

            return nodeProcessRunner.run(...args);
          },
        },
      };

      assert.equal(
        (await executeHook({ ...request(p.job, 'verify'), writersExcluded: false }, deps)).outcome,
        'rejected',
      );
      assert.equal(
        (await executeHook(request(p.job, 'verify'), deps, AbortSignal.abort())).outcome,
        'rejected',
      );
      assert.equal((await executeHook(request(p.job, 'setup'), deps)).outcome, 'rejected');
      assert.equal(
        (await executeHook({ ...request(p.job, 'verify'), commit: 'a'.repeat(40) }, deps)).outcome,
        'rejected',
      );
      assert.equal(
        (
          await executeHook(
            { ...request(p.job, 'verify'), allocations: [{ id: 'missing', expectedRevision: 0 }] },
            deps,
          )
        ).outcome,
        'rejected',
      );

      p.policy.execution.enabled = false;
      await writeFile(p.path, JSON.stringify(p.policy), { mode: 0o600 });

      assert.equal((await executeHook(request(p.job, 'verify'), deps)).outcome, 'rejected');
      assert.equal(calls, 0);
    });
  },
);
await test(
  'nonzero exit and changed HEAD remain failed domain results with retained cleanup holds',
  options,
  async () => {
    await fixture(async (f) => {
      const failed = await profile(f, 0, ['verify'], false, 'process.exit(7)');
      const result = hook(await executeHook(request(failed.job, 'verify'), failed.deps));

      assert.equal(result.status, 'failed');
      assert.equal(result.result?.exitCode, 7);
      assert.equal(result.shutdown, null);

      const changed = await profile(f, 1, ['verify']);
      const record = hook(
        await executeHook(request(changed.job, 'verify'), {
          ...changed.deps,
          runner: {
            run: async (...args) => {
              const result = await nodeProcessRunner.run(...args);
              git(args[0].cwd, 'commit', '--allow-empty', '-m', 'fixture concurrent HEAD');

              return result;
            },
          },
        }),
      );

      assert.equal(record.status, 'failed');
      assert.equal(record.reason, 'target_changed');
      assert.equal(
        hook(await executeHook(request(changed.job, 'verify'), changed.deps)).revision,
        record.revision,
      );
    });
  },
);
await test(
  'unknown execution never replays; new setup cannot bypass it and writer-excluded reconciliation preserves uncertainty',
  options,
  async () => {
    await fixture(async (f) => {
      const p = await profile(f, 0, ['setup', 'verify']);
      let calls = 0;
      const deps = {
        ...p.deps,
        runner: {
          run: async () => {
            calls++;

            throw new Error(secret);
          },
        },
      };
      const input = request(p.job, 'setup');
      const record = hook(await executeHook(input, deps));

      assert.equal(record.status, 'unknown');
      assert.equal(record.result, null);
      assert.ok(!JSON.stringify(record).includes(secret));
      assert.equal(hook(await executeHook(input, deps)).id, record.id);
      assert.equal(calls, 1);
      assert.equal(
        (await executeHook(request(p.job, 'setup', 'bypass'), deps)).outcome,
        'rejected',
      );
      assert.equal(calls, 1);

      const settled = reconcileHook(shutdown(record), deps);

      assert.ok(
        settled.outcome === 'persisted' &&
          settled.value.status === 'unknown' &&
          settled.value.shutdown,
      );
      assert.equal((await executeHook(input, deps)).outcome, 'persisted');
      assert.equal(calls, 1);
    });
  },
);
await test(
  'start hooks consume fresh allocation receipts; teardown evidence does not release resources automatically',
  options,
  async () => {
    await fixture(async (f) => {
      const p = await profile(f, 0, ['start', 'teardown'], true);
      let bound = false;
      const deps = {
        ...p.deps,
        ports: { inspect: async () => completed(bound ? ('busy' as const) : ('free' as const)) },
        runner: {
          run: async (...args: Parameters<typeof nodeProcessRunner.run>) => {
            const result = await nodeProcessRunner.run(...args);
            bound = args[0].args.some((a) => a.includes('start.json'));

            return result;
          },
        },
      };
      const reserved = allocation(
        await reserveAllocation(
          {
            schemaVersion: 1,
            jobId: p.job.job.id,
            attemptId: p.job.attempt.id,
            key: 'api',
            spec: { kind: 'port', protocol: 'tcp', host: '127.0.0.1', candidates: [45100] },
          },
          deps,
        ),
      );
      const started = hook(await executeHook(request(p.job, 'start', 'start', [reserved]), deps));

      assert.equal(started.status, 'succeeded');
      assert.deepEqual(started.endpoints, [{ id: reserved.id, observation: 'busy' }]);

      const pending = f.context.opened.allocations.inspect(reserved.id);

      assert.ok(pending.outcome === 'completed' && pending.value?.startup);

      const current = pending.value;
      const running = allocation(
        await confirmAllocationRunning(
          {
            schemaVersion: 1,
            id: current.id,
            expectedRevision: current.revision,
            key: current.startup!.key,
            controller: started.id,
            ownedEndpointVerified: true,
          },
          deps,
        ),
      );
      const ready = f.context.opened.hooks.prerequisitesReady(p.job.job.id);

      assert.ok(ready.outcome === 'completed' && ready.value);

      const stopped = hook(await executeHook(request(p.job, 'teardown', 'stop', [running]), deps));

      assert.equal(stopped.status, 'succeeded');
      assert.deepEqual(stopped.endpoints, [{ id: reserved.id, observation: 'free' }]);
      assert.equal(reconcileHook(shutdown(started), deps).outcome, 'rejected');

      const released = allocation(
        await releaseAllocation(
          {
            schemaVersion: 1,
            id: running.id,
            expectedRevision: running.revision,
            key: 'release',
            startupKey: running.startup!.key,
            writersStopped: true,
            servicesStopped: true,
          },
          deps,
        ),
      );

      assert.equal(released.phase, 'released');
      assert.equal(reconcileHook(shutdown(started), deps).outcome, 'persisted');
      assert.equal(reconcileHook(shutdown(stopped), deps).outcome, 'persisted');
    });
  },
);
await test(
  'static review skips service hooks and integration review only becomes ready with its own verified resources',
  options,
  async () => {
    await fixture(async (f) => {
      const p = await profile(f, 0, ['start'], true);
      const {
        description: _description,
        acceptanceCriteria: _criteria,
        ...base
      } = await f.prepare(1, 'review-hooks');
      const policyPath = join(f.context.state, 'config', 'project-1.json');
      const policy = hostConfigurationPolicySchema.parse(
        JSON.parse(await readFile(policyPath, 'utf8')),
      );
      policy.project.hooks = { setup: null, verify: null, teardown: null, start: 'hook-start' };
      policy.execution.allowedEnvironment = ['APP_PORT'];
      policy.execution.commands['hook-start'] = {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
      };
      policy.execution.hooks = {
        start: {
          command: 'hook-start',
          timeoutMs: 1000,
          environment: [],
          resources: { APP_PORT: { key: 'api', field: 'port' } },
        },
      };
      await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
      const input = reviewSubmitRequestSchema.parse({
        ...base,
        target: { host: 'github.com', repository: 'example/project', number: 20, sha: base.commit },
        resources: ['api'],
      });
      const snapshot: ReviewSnapshot = {
        target: input.target,
        baseSha: input.commit,
        state: 'OPEN',
        draft: false,
        sourceRepository: null,
        checks: [{ name: 'test', state: 'pass' }],
        observedAt: 100,
      };
      const reviewDeps: ReviewDependencies = {
        ...f.deps,
        hooks: f.context.opened.hooks,
        targets: { read: async () => completed(snapshot) },
      };
      const review = await submitReview(input, reviewDeps);

      assert.ok(review.outcome === 'persisted', JSON.stringify(review));

      const job = review.value.job;
      const deps = { ...p.deps, environment: { read: async () => completed({}) } };
      const own = allocation(
        await reserveAllocation(
          {
            schemaVersion: 1,
            jobId: job.job.id,
            attemptId: job.attempt.id,
            key: 'api',
            spec: { kind: 'port', protocol: 'tcp', host: '127.0.0.1', candidates: [45101] },
          },
          deps,
        ),
      );
      const before = f.context.opened.hooks.integrationReady(job.job.id);

      assert.ok(before.outcome === 'completed' && !before.value);

      const wrong = await executeHook(
        request(job, 'start', 'wrong', [
          allocation(
            await reserveAllocation(
              {
                schemaVersion: 1,
                jobId: p.job.job.id,
                attemptId: p.job.attempt.id,
                key: 'api',
                spec: { kind: 'port', protocol: 'tcp', host: '127.0.0.1', candidates: [45102] },
              },
              p.deps,
            ),
          ),
        ]),
        deps,
      );

      assert.equal(wrong.outcome, 'rejected');

      const started = hook(await executeHook(request(job, 'start', 'start', [own]), deps));

      assert.equal(started.status, 'succeeded');

      const selected = f.context.opened.allocations.inspect(own.id);

      assert.ok(selected.outcome === 'completed' && selected.value?.startup);

      const current = selected.value;
      allocation(
        await confirmAllocationRunning(
          {
            schemaVersion: 1,
            id: current.id,
            expectedRevision: current.revision,
            key: current.startup!.key,
            controller: started.id,
            ownedEndpointVerified: true,
          },
          { ...deps, ports: { inspect: async () => completed('busy') } },
        ),
      );
      const ready = f.context.opened.hooks.integrationReady(job.job.id);

      assert.ok(ready.outcome === 'completed' && ready.value);

      const runtime = createReviewRuntime({
        runtime: f.base,
        dependencies: reviewDeps,
        workerInput: f.workerInput,
      });
      const preflight = await runtime.preflight!(job, new AbortController().signal);

      assert.equal(preflight.outcome, 'completed', JSON.stringify(preflight));

      // A separate static assignment never gets service setup, even with a selected project start hook.
      const {
        description: _d,
        acceptanceCriteria: _c,
        ...staticBase
      } = await f.prepare(2, 'static-hooks');
      const staticInput = reviewSubmitRequestSchema.parse({
        ...staticBase,
        target: { ...input.target, number: 21, sha: staticBase.commit },
      });
      const staticDeps = {
        ...reviewDeps,
        targets: {
          read: async () =>
            completed({ ...snapshot, target: staticInput.target, baseSha: staticInput.commit }),
        },
      };
      const staticJob = await submitReview(staticInput, staticDeps);

      assert.ok(staticJob.outcome === 'persisted');

      const skipped = await executeHook(request(staticJob.value.job, 'setup'), deps);

      assert.deepEqual(skipped, { schemaVersion: 1, outcome: 'skipped', reason: 'static_review' });
    });
  },
);
await test(
  'hook CLI holds coordinator ownership, persists explicit execution and resolves from a neutral directory',
  options,
  async () => {
    await fixture(async (f) => {
      const p = await profile(f, 0, ['verify']);
      // This CLI fixture has no required external environment values.
      p.policy.execution.hooks!.verify!.environment = [];
      await writeFile(p.path, JSON.stringify(p.policy), { mode: 0o600 });
      const next = await f.prepare(1, 'cli-hooks');
      const otherPolicy = hostConfigurationPolicySchema.parse(
        JSON.parse(await readFile(join(f.context.state, 'config', 'project-1.json'), 'utf8')),
      );
      otherPolicy.project.hooks = { setup: null, verify: 'hook-verify', teardown: null };
      otherPolicy.execution.commands['hook-verify'] = {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
      };
      otherPolicy.execution.hooks = {
        verify: { command: 'hook-verify', timeoutMs: 1000, environment: [], resources: {} },
      };
      await writeFile(
        join(f.context.state, 'config', 'project-1.json'),
        JSON.stringify(otherPolicy),
        { mode: 0o600 },
      );
      const submitted = await submitImplementation(next, f.deps);

      assert.ok(submitted.outcome === 'persisted');

      const path = join(f.context.root, 'hook-request.json');
      await writeFile(path, JSON.stringify(request(submitted.value.job, 'verify')));
      const entry = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
      const call = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [entry, '--state-directory', f.context.state, 'hooks', ...args, '--json'],
          { cwd: f.context.root, encoding: 'utf8', timeout: 60000 },
        );
      const lock = await acquireCoordinatorOwnership(f.context.state);

      try {
        const blocked = call('execute', '--file', path);

        assert.equal(blocked.status, 1, blocked.stdout || blocked.stderr);

        const parsed: unknown = JSON.parse(blocked.stdout);

        assert.ok(
          parsed &&
            typeof parsed === 'object' &&
            'outcome' in parsed &&
            parsed.outcome === 'rejected',
        );
      } finally {
        lock.release();
      }

      const executed = call('execute', '--file', path);

      assert.equal(executed.status, 0, executed.stdout || executed.stderr);

      const record = hook(hookExecutionResultSchema.parse(JSON.parse(executed.stdout)));

      assert.equal(record.status, 'succeeded');

      const inspected = call('inspect', record.id);

      assert.equal(inspected.status, 0, inspected.stderr);

      hookRecordSchema.parse((JSON.parse(inspected.stdout) as { value: unknown }).value);
      await assert.rejects(access(join(f.context.root, '.astack')), { code: 'ENOENT' });
    });
  },
);

await test(
  'deadline and cancellation keep process cause separate from task success and service shutdown',
  options,
  async () => {
    await fixture(async (f) => {
      const timed = await profile(f, 0, ['verify'], false, 'setInterval(()=>{},1000)');
      const cancelled = await profile(f, 1, ['verify'], false, 'setInterval(()=>{},1000)');
      const controller = new AbortController();
      const timerRunner: HookDependencies = {
        ...cancelled.deps,
        runner: {
          run: async (...args) => {
            const timer = setTimeout(() => controller.abort(), 50);

            try {
              return await nodeProcessRunner.run(...args);
            } finally {
              clearTimeout(timer);
            }
          },
        },
      };
      const [a, b] = await Promise.all([
        executeHook(request(timed.job, 'verify'), timed.deps),
        executeHook(request(cancelled.job, 'verify'), timerRunner, controller.signal),
      ]);
      const timeout = hook(a),
        cancellation = hook(b);

      assert.equal(timeout.result?.outcome, 'timed_out');
      assert.notEqual(timeout.status, 'succeeded');
      assert.equal(cancellation.result?.outcome, 'cancelled');
      assert.notEqual(cancellation.status, 'succeeded');
      assert.equal(timeout.shutdown, null);
      assert.equal(cancellation.shutdown, null);
    });
  },
);
await test(
  'lost completion receipt remains executing; explicit writer exclusion permits teardown without releasing cleanup holds',
  options,
  async () => {
    await fixture(async (f) => {
      const p = await profile(f, 0, ['verify', 'teardown']);
      let calls = 0;
      const deps: HookDependencies = {
        ...p.deps,
        hooks: {
          ...p.deps.hooks,
          finish: () => ({
            schemaVersion: 1,
            outcome: 'uncertain',
            error: { code: 'state_write_uncertain', message: 'fixture lost acknowledgement' },
          }),
        },
        runner: {
          run: async (...args) => {
            calls++;

            return nodeProcessRunner.run(...args);
          },
        },
      };
      const input = request(p.job, 'verify');
      const uncertain = await executeHook(input, deps);

      assert.equal(uncertain.outcome, 'uncertain');

      const pending = hook(await executeHook(input, deps));

      assert.equal(pending.status, 'executing');
      assert.equal(calls, 1);
      assert.equal((await executeHook(request(p.job, 'teardown'), p.deps)).outcome, 'rejected');

      const excluded = excludeHookWriter(
        {
          schemaVersion: 1,
          id: pending.id,
          expectedRevision: pending.revision,
          key: 'exclude-controller',
          writersStopped: true,
        },
        p.deps,
      );

      assert.ok(
        excluded.outcome === 'persisted' &&
          excluded.value.status === 'unknown' &&
          excluded.value.shutdown === null,
      );

      const stopped = hook(await executeHook(request(p.job, 'teardown'), p.deps));

      assert.equal(stopped.status, 'succeeded');

      const generic = f.context.opened.store.releaseResource({
        schemaVersion: 1,
        resourceId: pending.id,
        attemptId: p.job.attempt.id,
        evidence: { stopped: true },
      });

      assert.equal(generic.outcome, 'rejected');
      assert.equal(reconcileHook(shutdown(excluded.value), p.deps).outcome, 'persisted');
      assert.equal(reconcileHook(shutdown(stopped), p.deps).outcome, 'persisted');
    });
  },
);

await test(
  'partial resource startup preserves earlier receipts and never runs or retries the command',
  options,
  async () => {
    await fixture(async (f) => {
      const p = await profile(f, 0, ['start'], true, undefined, (policy) => {
        policy.execution.allowedEnvironment.push('DB_PORT');
        policy.execution.hooks!.start!.resources.DB_PORT = { key: 'db', field: 'port' };
      });
      let rejectDatabase = false;
      let runs = 0;
      const deps: HookDependencies = {
        ...p.deps,
        ports: {
          inspect: async (endpoint) =>
            completed(rejectDatabase && endpoint.port === 45201 ? 'busy' : 'free'),
        },
        runner: {
          run: async (...args) => {
            runs++;

            return nodeProcessRunner.run(...args);
          },
        },
      };
      const reserve = async (key: string, port: number) =>
        allocation(
          await reserveAllocation(
            {
              schemaVersion: 1,
              jobId: p.job.job.id,
              attemptId: p.job.attempt.id,
              key,
              spec: { kind: 'port', protocol: 'tcp', host: '127.0.0.1', candidates: [port] },
            },
            deps,
          ),
        );
      const api = await reserve('api', 45200),
        db = await reserve('db', 45201);
      rejectDatabase = true;
      const input = request(p.job, 'start', 'partial', [api, db]);
      const failed = hook(await executeHook(input, deps));

      assert.equal(failed.status, 'failed');
      assert.equal(failed.reason, 'prerequisites_changed');
      assert.equal(runs, 0);

      const retained = f.context.opened.allocations.inspect(api.id);

      assert.ok(retained.outcome === 'completed' && retained.value?.phase === 'starting');

      const blocked = f.context.opened.allocations.inspect(db.id);

      assert.ok(blocked.outcome === 'completed' && blocked.value?.phase === 'blocked');
      assert.equal(hook(await executeHook(input, deps)).id, failed.id);
      assert.equal(runs, 0);
      assert.equal(reconcileHook(shutdown(failed), deps).outcome, 'rejected');
    });
  },
);
