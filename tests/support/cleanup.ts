import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServiceCoordinator } from '../../src/application/service.js';
import { acceptRunReport } from '../../src/application/runs.js';
import { nodeRunArtifactReader } from '../../src/adapters/filesystem/run-artifacts.js';
import { fixture as taskFixture } from './task.js';
import { genericRuntime, submitFixture } from './generic-job.js';
import { git } from './service.js';

async function setup(context: Parameters<Parameters<typeof taskFixture>[0]>[0]) {
  const request = await context.prepare();
  const submitted = await submitFixture(context, request, context.deps);

  assert.ok(submitted.outcome === 'persisted', JSON.stringify(submitted));

  const job = submitted.value;
  const task = job.job.intent.task;

  assert.ok(
    task && typeof task === 'object' && !Array.isArray(task) && typeof task.root === 'string',
  );

  const root = task.root;
  const coordinator = createServiceCoordinator({
    sessionId: 'generic-cleanup-fixture',
    dependencies: context.deps,
    runtimes: [genericRuntime(context)],
    limits: { global: 1, defaultRole: 1, perRole: {} },
    onFailure: () => assert.fail('Coordinator failed'),
  });
  coordinator.start();

  try {
    await coordinator.idle();
  } finally {
    await coordinator.stop();
  }

  await writeFile(join(root, 'result.txt'), 'Completed fixture task\n');
  await writeFile(join(root, '.gitignore'), '.verification.json\n');
  git(root, 'add', 'result.txt', '.gitignore');
  git(root, 'commit', '-m', 'feat: complete fixture');
  const head = git(root, 'rev-parse', 'HEAD');
  const content = '{"result":"passed"}\n';
  const artifact = {
    path: '.verification.json',
    digest: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  };
  await writeFile(join(root, artifact.path), content);
  const report = await acceptRunReport(
    {
      schemaVersion: 1,
      jobId: job.job.id,
      key: 'completed-report',
      proposal: {
        schemaVersion: 1,
        jobId: job.job.id,
        attemptId: job.attempt.id,
        projectId: job.job.projectId,
        checkoutId: job.job.checkoutId,
        outcome: 'completed',
        summary: 'Completed fixture task',
        blockers: [],
      },
      artifacts: [artifact],
    },
    {
      ...context.deps,
      runs: context.context.opened.runs,
      artifacts: nodeRunArtifactReader,
      workerInput: context.workerInput,
      workerControl: { interrupt: async () => assert.fail('No worker controls') },
    },
  );

  assert.ok(report.outcome === 'persisted' && report.value.report, JSON.stringify(report));

  return { context, root, head, job, artifact };
}

export type CleanupFixture = Awaited<ReturnType<typeof setup>>;
export async function fixture(action: (context: CleanupFixture) => Promise<void>) {
  await taskFixture(async (context) => action(await setup(context)));
}
