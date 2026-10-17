import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  prepareWorktree,
  createWorktreeGit,
  nodeProcessRunner,
  createNodeWorktreeFiles,
  nodeImplementationContextReader,
  createImplementationRuntime,
  type ImplementationDependencies,
  type ImplementationSubmitRequest,
  type ImplementationInputReceipt,
  type ImplementationWorkerInput,
  type ServiceWorkerRuntime,
  type ServiceJob,
  type WorkerObservation,
} from '../../src/index.js';
import { completed } from '../../src/contracts/operation-result.js';
import { workerInputDigest } from '../../src/core/worker-input.js';
import { fixture as serviceFixture, gitPath, git } from './service.js';

export async function fixture(
  action: (context: {
    deps: ImplementationDependencies;
    context: Parameters<Parameters<typeof serviceFixture>[0]>[0];
    prepare: (index?: number, key?: string) => Promise<ImplementationSubmitRequest>;
    runtime: ServiceWorkerRuntime;
    base: ServiceWorkerRuntime;
    workerInput: ImplementationWorkerInput;
    receipts: Map<string, ImplementationInputReceipt>;
    prompts: { attemptId: string; key: string; text: string }[];
    launches: string[];
    modes: { runtime: string; input: string; agentStatus: string };
  }) => Promise<void>,
) {
  await serviceFixture(async (context) => {
    const files = createNodeWorktreeFiles(join(context.state, 'worktrees'));
    const deps: ImplementationDependencies = {
      ...context.deps,
      files,
      worktrees: context.opened.worktrees,
      instructions: nodeImplementationContextReader,
    };
    let sequence = 0;
    const prepare = async (
      index = 0,
      key = `task-${index}`,
    ): Promise<ImplementationSubmitRequest> => {
      const source = context.sources[index];

      assert.ok(source);

      await writeFile(
        join(source, 'AGENTS.md'),
        `# Fixture project ${index}\nPreserve this project's conventions.\n`,
      );
      git(source, 'add', 'AGENTS.md');
      git(source, 'commit', '-m', `fixture instructions ${index}`);
      const commit = git(source, 'rev-parse', 'HEAD');
      const prepared = await prepareWorktree(
        {
          schemaVersion: 1,
          projectId: `project-${index}`,
          key,
          branch: `refs/heads/${key}`,
          baseCommit: commit,
        },
        {
          ...context.deps,
          store: context.opened.worktrees,
          files,
          managedRoot: join(context.state, 'worktrees'),
          effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
          nextId: (kind) => `${kind}-implementation-${++sequence}`,
        },
      );

      assert.ok(
        'record' in prepared && prepared.record.phase === 'ready',
        JSON.stringify(prepared),
      );

      const request = {
        schemaVersion: 1 as const,
        projectId: prepared.record.intent.projectId,
        checkoutId: prepared.record.intent.checkoutId,
        key,
        branch: prepared.record.intent.branch,
        commit,
        description: `Implement selected task for project ${index}.`,
        acceptanceCriteria: ['Preserve the requested behavior.'],
        instructionPaths: ['AGENTS.md', 'AGENTS.override.md'],
        request: {},
      };

      return request;
    };

    const receipts = new Map<string, ImplementationInputReceipt>();
    const prompts: { attemptId: string; key: string; text: string }[] = [];
    const launches: string[] = [];
    const modes = { runtime: 'running', input: 'acknowledged', agentStatus: 'idle' };
    function observation(job: ServiceJob): WorkerObservation {
      if (modes.runtime === 'throw') {
        throw new Error('fixture-private-runtime-error');
      }

      return modes.runtime === 'refused'
        ? { state: 'not_started', handle: null, evidence: { reason: 'fixture-refused' } }
        : modes.runtime === 'unknown'
          ? { state: 'unknown', handle: null, evidence: {} }
          : {
              state: 'running',
              handle: { attemptId: job.attempt.id },
              evidence: { agentStatus: modes.agentStatus },
            };
    }

    const base: ServiceWorkerRuntime = {
      id: 'fixture',
      start: async (job) => {
        launches.push(job.attempt.id);

        return observation(job);
      },
      inspect: async (job) => observation(job),
    };
    const workerInput: ImplementationWorkerInput = {
      receipt: ({ attemptId, key }) => completed(receipts.get(`${attemptId}:${key}`) ?? null),
      async submit(input) {
        const id = `${input.attemptId}:${input.key}`;
        const existing = receipts.get(id);

        if (existing) {
          return completed({ receipt: existing, blocker: null });
        }

        if (modes.input === 'busy') {
          return completed({ receipt: null, blocker: 'busy' });
        }

        const accepted = await context.opened.registry.readRun(input.attemptId);

        assert.ok(accepted.outcome === 'completed' && accepted.value);

        const receipt: ImplementationInputReceipt = {
          key: input.key,
          digest: workerInputDigest('input', input.text),
          state: 'pending',
        };
        receipts.set(id, receipt);
        prompts.push(input);

        if (modes.input === 'lost') {
          throw new Error('fixture-private-input-error');
        }

        receipt.state = 'acknowledged';

        return completed({ receipt, blocker: null });
      },
    };
    const runtime = createImplementationRuntime({ runtime: base, dependencies: deps, workerInput });
    await action({
      deps,
      context,
      prepare,
      runtime,
      base,
      workerInput,
      receipts,
      prompts,
      launches,
      modes,
    });
  });
}
