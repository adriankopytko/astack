import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  submitImplementation,
  inspectImplementation,
  createServiceCoordinator,
  implementationSubmitResultSchema,
  implementationReadResultSchema,
  implementationWorkerReportSchema,
  implementationSubmitRequestSchema,
  nodeImplementationContextReader,
  requestLocalService,
  startLocalService,
  type ImplementationJob,
  type StateWriteResult,
} from '../src/index.js';
import { fixture } from './support/implementation.js';
import { gitPath } from './support/service.js';

const options = { timeout: 90_000 };
function accepted(result: StateWriteResult<ImplementationJob>): ImplementationJob {
  implementationSubmitResultSchema.parse(result);

  if (result.outcome !== 'persisted') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

function saved(
  jobId: string,
  deps: Parameters<typeof inspectImplementation>[1],
): ImplementationJob {
  const result = inspectImplementation({ schemaVersion: 1, jobId }, deps);
  implementationReadResultSchema.parse(result);

  if (result.outcome !== 'completed' || !result.value) {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

function coordinator(context: Parameters<Parameters<typeof fixture>[0]>[0], global = 1) {
  return createServiceCoordinator({
    sessionId: 'implementation-service',
    limits: { global, defaultRole: global, perRole: {} },
    runtimes: [context.runtime],
    dependencies: context.deps,
    onFailure: () => assert.fail('Fixture coordinator failed'),
  });
}

await test(
  'explicit implementation acceptance persists owned assignment, instructions, policy and attempt without launching',
  options,
  async () => {
    await fixture(async ({ prepare, deps, launches, prompts }) => {
      const request = await prepare();
      const result = await submitImplementation(request, deps);
      const job = accepted(result);

      assert.equal(job.implementation.state, 'queued');
      assert.equal(job.implementation.acceptedOutcome, null);
      assert.equal(job.job.entry.role, 'implementer');
      assert.equal(job.job.job.checkoutId, request.checkoutId);
      assert.ok(job.job.job.configuration);
      assert.equal(job.job.effect.state, 'pending');

      const task = job.job.job.intent.task;

      assert.ok(task && typeof task === 'object' && !Array.isArray(task));
      assert.equal(task.workflow, 'implementation');
      assert.equal(JSON.stringify(task).includes("Preserve this project's conventions"), false);
      assert.equal(launches.length, 0);
      assert.equal(prompts.length, 0);

      const primary = await deps.registry.readProject('project-0');

      assert.ok(primary.outcome === 'completed' && primary.value);

      const unowned = await submitImplementation(
        {
          ...request,
          checkoutId: primary.value.project.primaryCheckoutId,
          key: 'unowned',
          branch: 'refs/heads/main',
        },
        deps,
      );

      assert.equal(unowned.outcome, 'rejected');
    });
  },
);

await test(
  'two projects queue under capacity and receive only their saved assignment and result contract',
  options,
  async () => {
    await fixture(async (context) => {
      const firstRequest = await context.prepare(0);
      const secondRequest = await context.prepare(1);
      secondRequest.key = firstRequest.key;
      const first = accepted(await submitImplementation(firstRequest, context.deps));
      const second = accepted(await submitImplementation(secondRequest, context.deps));
      const service = coordinator(context);
      service.start();

      try {
        await service.idle();

        assert.equal(saved(first.job.job.id, context.deps).implementation.state, 'started');
        assert.equal(saved(second.job.job.id, context.deps).implementation.state, 'queued');
        assert.equal(context.prompts.length, 1);

        const prompt = context.prompts[0]?.text ?? '';

        assert.match(prompt, /Implementation assignment v1/);
        assert.ok(prompt.includes(first.job.job.id));
        assert.ok(prompt.includes(first.job.attempt.id));
        assert.ok(prompt.includes(firstRequest.checkoutId));
        assert.ok(prompt.includes(firstRequest.commit));
        assert.ok(prompt.includes('AGENTS.md'));
        assert.ok(prompt.includes('needs_decision'));
        assert.equal(prompt.includes(secondRequest.checkoutId), false);
        assert.equal(context.launches.length, 1);

        service.wake();
        await service.idle();

        assert.equal(context.prompts.length, 1);
        assert.equal(saved(first.job.job.id, context.deps).implementation.acceptedOutcome, null);
      } finally {
        await service.stop();
      }

      const expanded = coordinator(context, 2);
      expanded.start();

      try {
        await expanded.idle();

        assert.equal(context.prompts.length, 2);
        assert.equal(saved(second.job.job.id, context.deps).implementation.state, 'started');

        const prompt = context.prompts[1]?.text ?? '';

        assert.ok(prompt.includes(second.job.job.id));
        assert.ok(prompt.includes(secondRequest.checkoutId));
        assert.equal(prompt.includes(firstRequest.checkoutId), false);
        assert.equal(context.launches.length, 2);
      } finally {
        await expanded.stop();
      }
    });
  },
);

await test(
  'duplicate submission returns original identity after worker edits and policy revocation, while changed intent conflicts',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await context.prepare();
      const job = accepted(await submitImplementation(request, context.deps));
      const service = coordinator(context);
      service.start();

      try {
        await service.idle();
        const checkout = await context.deps.registry.readCheckout(request.checkoutId);

        assert.ok(checkout.outcome === 'completed' && checkout.value);

        await writeFile(
          join(checkout.value.checkout.rootPath, 'worker-change.txt'),
          'fixture change',
        );
        await writeFile(join(context.context.state, 'config/project-0.json'), '{}', {
          mode: 0o600,
        });
        const repeat = await submitImplementation(request, context.deps);

        assert.equal(accepted(repeat).job.job.id, job.job.job.id);
        assert.ok(repeat.outcome === 'persisted' && repeat.disposition === 'existing');

        const changed = await submitImplementation(
          { ...request, description: 'A different task.' },
          context.deps,
        );

        assert.ok(changed.outcome === 'rejected' && changed.error.code === 'state_conflict');
        assert.equal(context.prompts.length, 1);
      } finally {
        await service.stop();
      }
    });
  },
);

await test(
  'worker approval blockers stay needs-decision and idle/done never become accepted success',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await context.prepare();
      const job = accepted(await submitImplementation(request, context.deps));
      context.modes.agentStatus = 'blocked';
      const service = coordinator(context);
      service.start();

      try {
        await service.idle();

        assert.equal(saved(job.job.job.id, context.deps).implementation.state, 'needs_decision');
        assert.equal(context.prompts.length, 0);

        context.modes.agentStatus = 'idle';
        service.wake();
        await service.idle();

        assert.equal(context.prompts.length, 1);

        context.modes.agentStatus = 'done';
        service.wake();
        await service.idle();
        const result = saved(job.job.job.id, context.deps);

        assert.equal(result.implementation.state, 'started');
        assert.equal(result.implementation.acceptedOutcome, null);

        const attempt = context.context.opened.store.inspectRecord({
          schemaVersion: 1,
          entity: 'attempt',
          id: job.job.attempt.id,
        });

        assert.ok(
          attempt.outcome === 'completed' &&
            attempt.value?.entity === 'attempt' &&
            attempt.value.resolvedAt === null,
        );
      } finally {
        await service.stop();
      }
    });
  },
);

await test(
  'lost prompt acknowledgement remains unknown across reconnect and is never submitted again',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await context.prepare();
      const job = accepted(await submitImplementation(request, context.deps));
      context.modes.input = 'lost';
      const first = coordinator(context);
      first.start();
      await first.idle();
      await first.stop();

      assert.equal(saved(job.job.job.id, context.deps).implementation.state, 'unknown');

      const second = coordinator(context);
      second.start();

      try {
        await second.idle();

        assert.equal(context.prompts.length, 1);
        assert.equal(context.launches.length, 1);
        assert.equal(saved(job.job.job.id, context.deps).implementation.delivery, 'pending');
      } finally {
        await second.stop();
      }
    });
  },
);

await test(
  'proven launch refusal is failed while uncertain runtime failure stays unknown',
  options,
  async () => {
    await fixture(async (context) => {
      const first = accepted(await submitImplementation(await context.prepare(0), context.deps));
      context.modes.runtime = 'refused';
      let service = coordinator(context);
      service.start();
      await service.idle();
      await service.stop();

      assert.equal(saved(first.job.job.id, context.deps).implementation.state, 'failed');
      assert.equal(context.prompts.length, 0);

      const second = accepted(await submitImplementation(await context.prepare(1), context.deps));
      context.modes.runtime = 'throw';
      service = coordinator(context);
      service.start();

      try {
        await service.idle();

        assert.equal(saved(second.job.job.id, context.deps).implementation.state, 'unknown');
        assert.equal(saved(second.job.job.id, context.deps).implementation.acceptedOutcome, null);
      } finally {
        await service.stop();
      }
    });
  },
);

await test(
  'instruction drift and policy revocation block first input without granting a replacement launch',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await context.prepare();
      const job = accepted(await submitImplementation(request, context.deps));
      const checkout = await context.deps.registry.readCheckout(request.checkoutId);

      assert.ok(checkout.outcome === 'completed' && checkout.value);

      await writeFile(
        join(checkout.value.checkout.rootPath, 'AGENTS.md'),
        'Changed after acceptance.',
      );
      const service = coordinator(context);
      service.start();

      try {
        await service.idle();

        assert.equal(saved(job.job.job.id, context.deps).implementation.state, 'blocked');
        assert.equal(context.prompts.length, 0);
        assert.equal(context.launches.length, 0);

        await writeFile(join(context.context.state, 'config/project-0.json'), '{}', {
          mode: 0o600,
        });
        service.wake();
        await service.idle();

        assert.equal(saved(job.job.job.id, context.deps).job.entry.reason, 'configuration_blocked');
        assert.equal(context.launches.length, 0);
      } finally {
        await service.stop();
      }
    });
  },
);

await test(
  'runtime without declared workflow support blocks before capacity claim or launch',
  options,
  async () => {
    await fixture(async (context) => {
      const job = accepted(await submitImplementation(await context.prepare(), context.deps));
      const service = createServiceCoordinator({
        sessionId: 'unsupported',
        limits: { global: 1, defaultRole: 1, perRole: {} },
        runtimes: [context.base],
        dependencies: context.deps,
        onFailure: () => assert.fail('Coordinator failure'),
      });
      service.start();

      try {
        await service.idle();
        const result = saved(job.job.job.id, context.deps);

        assert.equal(result.implementation.state, 'blocked');
        assert.equal(result.job.entry.reason, 'workflow_unavailable');
        assert.equal(result.job.entry.claim, null);
        assert.equal(context.launches.length, 0);
      } finally {
        await service.stop();
      }
    });
  },
);

await test('malformed and cancelled implementation requests never inspect context or accept jobs', async () => {
  const deps = { queue: { find: () => assert.fail('Unexpected read') } } as unknown as Parameters<
    typeof submitImplementation
  >[1];
  const invalid = await submitImplementation({ schemaVersion: 2 }, deps);

  assert.ok(
    invalid.outcome === 'rejected' && invalid.error.code === 'unsupported_contract_version',
  );
  assert.equal(implementationSubmitRequestSchema.safeParse({ schemaVersion: 1 }).success, false);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await submitImplementation(
    {
      schemaVersion: 1,
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      key: 'task',
      branch: 'refs/heads/task',
      commit: 'a'.repeat(40),
      description: 'Fixture task.',
    },
    deps,
    controller.signal,
  );

  assert.ok(cancelled.outcome === 'rejected' && cancelled.error.code === 'cancelled');
  assert.equal(implementationWorkerReportSchema.safeParse({ outcome: 'success' }).success, false);
});

await test('repository context reader preserves absent files and rejects links, traversal and oversized instruction bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'implementation-context-'));

  try {
    const { realpath } = await import('node:fs/promises');
    const canonical = await realpath(root);
    await writeFile(join(canonical, 'AGENTS.md'), 'Fixture instructions.');
    const input = { root: canonical, paths: ['AGENTS.md', 'AGENTS.override.md'] };
    const result = await nodeImplementationContextReader.read(input);

    assert.ok(result.outcome === 'completed');
    assert.equal(result.value[1]?.digest, null);
    assert.match(result.value[0]?.digest ?? '', /^[a-f0-9]{64}$/);

    await symlink(join(canonical, 'AGENTS.md'), join(canonical, 'linked.md'));

    assert.equal(
      (await nodeImplementationContextReader.read({ ...input, paths: ['linked.md'] })).outcome,
      'rejected',
    );
    assert.equal(
      (await nodeImplementationContextReader.read({ ...input, paths: ['../AGENTS.md'] })).outcome,
      'rejected',
    );

    await writeFile(join(canonical, 'large.md'), Buffer.alloc(65_537));

    assert.equal(
      (await nodeImplementationContextReader.read({ ...input, paths: ['large.md'] })).outcome,
      'rejected',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test(
  'live local transport accepts implementation intent and compiled CLI inspects it from neutral cwd',
  options,
  async () => {
    await fixture(async (context) => {
      const request = await context.prepare();
      const service = await startLocalService({
        schemaVersion: 1,
        stateDirectory: context.context.state,
        gitExecutable: gitPath,
      });

      assert.equal(service.outcome, 'listening', JSON.stringify(service));

      if (service.outcome !== 'listening') {
        assert.fail('Missing fixture service');
      }

      try {
        const receipt = await requestLocalService(context.context.state, {
          ...request,
          operation: 'implement_submit',
        });

        assert.ok(
          receipt.outcome === 'persisted' && 'implementation' in receipt.value,
          JSON.stringify(receipt),
        );

        const job = receipt.value as ImplementationJob;
        const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
        const inspected = spawnSync(
          process.execPath,
          [
            cli,
            '--state-directory',
            context.context.state,
            'implement',
            'inspect',
            job.job.job.id,
            '--json',
          ],
          { cwd: context.context.root, encoding: 'utf8', timeout: 15_000 },
        );

        assert.ok(inspected.status === 0 || inspected.status === 1, inspected.stderr);

        const result = implementationReadResultSchema.parse(JSON.parse(inspected.stdout));

        assert.ok(result.outcome === 'completed' && result.value?.job.job.id === job.job.job.id);
        assert.equal(context.launches.length, 0);

        const unknown = spawnSync(process.execPath, [cli, 'implement', 'invented'], {
          cwd: context.context.root,
          encoding: 'utf8',
        });

        assert.equal(unknown.status, 1);
        assert.match(unknown.stderr, /unknown command/);
      } finally {
        await service.close();
      }
    });
  },
);
