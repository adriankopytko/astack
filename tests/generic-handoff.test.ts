import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './support/herdr.js';
import { git, writeProjectConfiguration } from './support/service.js';
import { startLocalService } from '../src/host/local-service.js';
import { requestLocalService } from '../src/adapters/local/service-client.js';
import { completed } from '../src/contracts/operation-result.js';
import { workerInputDigest } from '../src/core/worker-input.js';
import type { ImplementationInputReceipt } from '../src/contracts/implementation-task.js';
import { readGithubOrigin } from '../src/adapters/git/github-origin.js';
import { nodeProcessRunner } from '../src/core/node-process-runner.js';
import { gitPath } from './support/service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

await test('the GitHub repository can be inferred from a project origin', async () => {
  await fixture(async ({ sources }) => {
    git(sources[0]!, 'remote', 'add', 'origin', 'git@github.com:Example/Project.git');
    const result = await readGithubOrigin(sources[0]!, gitPath, nodeProcessRunner);

    assert.ok(result.outcome === 'completed');
    assert.deepEqual(result.value, { host: 'github.com', repository: 'example/project' });
  });
});

await test(
  'a project-defined agent receives a generic handoff and records its result',
  { timeout: 90000 },
  async () => {
    await fixture(async ({ configure, fake, opened, state, sources }) => {
      await configure();
      await writeProjectConfiguration({ state, sources }, 0);
      git(sources[0]!, 'remote', 'add', 'origin', 'git@github.com:example/project.git');
      const path = join(sources[0]!, '.astack', 'config.json');
      const config = JSON.parse(await readFile(path, 'utf8')) as {
        agents: Record<string, Record<string, unknown>>;
      };
      config.agents.researcher = {
        ...config.agents.implementer,
        description: 'Investigates questions.',
        instructions: 'Investigate the task carefully.',
        workspacePrefix: 'RSH',
        hooks: { before: `printf ready > '${state}/generic-hook'` },
      };
      await writeFile(path, JSON.stringify(config));
      const receipts = new Map<string, ImplementationInputReceipt>();
      const prompts: string[] = [];
      let release = false;
      const workerInput = {
        receipt({ attemptId, key }: { attemptId: string; key: string }) {
          return completed(receipts.get(`${attemptId}:${key}`) ?? null);
        },
        async submit(input: { attemptId: string; key: string; text: string }) {
          const receipt: ImplementationInputReceipt = {
            key: input.key,
            digest: workerInputDigest('input', input.text),
            state: 'acknowledged',
          };
          receipts.set(`${input.attemptId}:${input.key}`, receipt);
          prompts.push(input.text);

          return completed({ receipt, blocker: null });
        },
      };
      const runtime = {
        id: 'fixture',
        async start() {
          return { state: 'running' as const, handle: {}, evidence: { agentStatus: 'idle' } };
        },
        async inspect() {
          return {
            state: release ? ('quiescent' as const) : ('running' as const),
            handle: {},
            evidence: { agentStatus: 'idle' },
          };
        },
      };
      const baseSha = git(sources[0]!, 'rev-parse', 'HEAD');
      git(sources[0]!, 'commit', '--allow-empty', '-m', 'PR head');
      const sha = git(sources[0]!, 'rev-parse', 'HEAD');
      const service = await startLocalService(
        {
          schemaVersion: 1,
          stateDirectory: state,
          limits: { global: 1, defaultRole: 1, perRole: {} },
        },
        {
          workerSetupProvider: fake.provider,
          implementationBase: { resolve: async () => completed(sha) },
          runtimes: [runtime],
          runWorkerInput: workerInput,
          githubContext: {
            async read({ reference }) {
              if (reference.kind === 'pr') {
                return completed({
                  kind: 'pr' as const,
                  title: 'Pull request',
                  body: 'Changes to inspect',
                  reference: 'github.com/example/project#87',
                  headSha: sha,
                  baseSha,
                });
              }

              return completed({
                kind: 'issue' as const,
                title: 'Long issue',
                body: 'x'.repeat(8000),
                reference: 'github.com/example/project#42',
              });
            },
          },
        },
      );

      assert.ok(service.outcome === 'listening', JSON.stringify(service));

      try {
        const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
        const listing = await promisify(execFile)(
          process.execPath,
          [cli, '--state-directory', state, 'agents', 'list', '--json'],
          { cwd: sources[0] },
        );
        const agents = JSON.parse(listing.stdout) as {
          agents: { name: string; description: string }[];
        };

        assert.ok(
          agents.agents.some(
            (agent) =>
              agent.name === 'researcher' && agent.description === 'Investigates questions.',
          ),
        );

        const submission = await promisify(execFile)(
          process.execPath,
          [
            cli,
            '--state-directory',
            state,
            'handoff',
            'submit',
            '--agent',
            'researcher',
            '--task',
            'Investigate this problem',
            '--issue',
            '42',
            '--json',
          ],
          { cwd: sources[0] },
        );
        const submitted = JSON.parse(submission.stdout) as {
          outcome: string;
          value: { id: string; request: unknown };
        };

        assert.ok(
          submitted.outcome === 'persisted' && 'request' in submitted.value,
          JSON.stringify(submitted),
        );

        for (let i = 0; i < 400 && prompts.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.equal(prompts.length, 1);
        assert.match(prompts[0]!, /Investigate this problem/);
        assert.match(prompts[0]!, /Investigate the task carefully/);
        assert.equal(await readFile(join(state, 'generic-hook'), 'utf8'), 'ready');

        const job = opened.service.read(submitted.value.id);

        assert.ok(job.outcome === 'completed' && job.value);
        assert.equal(job.value.entry.role, 'researcher');
        assert.equal(job.value.job.operation, 'handoff');

        const task = job.value.job.intent.task as { contextPath?: string; root: string };

        assert.ok(typeof task?.contextPath === 'string');
        assert.equal(
          (JSON.parse(await readFile(task.contextPath, 'utf8')) as { body: string }).body.length,
          8000,
        );
        assert.ok(prompts[0]!.includes(task.contextPath));

        const secondOutput = await promisify(execFile)(
          process.execPath,
          [
            cli,
            '--state-directory',
            state,
            'handoff',
            'submit',
            '--agent',
            'researcher',
            '--task',
            'Another task',
            '--json',
          ],
          { cwd: sources[0] },
        );
        const second = JSON.parse(secondOutput.stdout) as { value: { id: string } };
        await new Promise((resolve) => setTimeout(resolve, 300));
        const waiting = opened.workerQueue.read(second.value.id);

        assert.ok(waiting.outcome === 'completed' && waiting.value?.state === 'queued');
        assert.equal(fake.calls.filter((call) => call.operation === 'create-worker').length, 1);

        const cancelled = await requestLocalService(state, {
          schemaVersion: 1,
          operation: 'run_cancel',
          jobId: second.value.id,
          key: 'cancel-test',
          interrupt: false,
        });

        assert.equal(cancelled.outcome, 'persisted');

        await writeFile(join(task.root, 'findings.md'), 'Detailed findings.');

        const output = await promisify(execFile)(
          process.execPath,
          [
            cli,
            '--state-directory',
            state,
            'run',
            'finish',
            job.value.job.id,
            '--status',
            'completed',
            '--summary',
            'Investigation finished.',
            '--artifact',
            'findings.md',
            '--json',
          ],
          { cwd: sources[0] },
        );
        const report = JSON.parse(output.stdout) as {
          outcome: string;
          value: { status: string; report: { request: { artifacts: { path: string }[] } } };
        };

        assert.ok(
          report.outcome === 'persisted' && 'status' in report.value,
          JSON.stringify(report),
        );
        assert.equal(report.value.status, 'completed');
        assert.equal(report.value.report.request.artifacts[0]?.path, 'findings.md');

        release = true;
        await requestLocalService(state, { schemaVersion: 1, operation: 'wake' });
        const prOutput = await promisify(execFile)(
          process.execPath,
          [
            cli,
            '--state-directory',
            state,
            'handoff',
            'submit',
            '--agent',
            'researcher',
            '--pr',
            '87',
            '--base',
            'pr-head',
            '--json',
          ],
          { cwd: sources[0] },
        );
        const pr = JSON.parse(prOutput.stdout) as { value: { id: string } };

        for (let i = 0; i < 400 && prompts.length < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.equal(prompts.length, 2);

        const prJob = opened.service.read(pr.value.id);

        assert.ok(prJob.outcome === 'completed' && prJob.value);

        const prTask = prJob.value.job.intent.task as { contextPath: string };
        const context = JSON.parse(await readFile(prTask.contextPath, 'utf8')) as {
          baseSha: string;
          headSha: string;
          body: string;
        };

        assert.equal(context.baseSha, baseSha);
        assert.equal(context.headSha, sha);
        assert.equal(context.body, 'Changes to inspect');

        const blocked = await promisify(execFile)(
          process.execPath,
          [
            cli,
            '--state-directory',
            state,
            'run',
            'finish',
            pr.value.id,
            '--status',
            'needs-input',
            '--summary',
            'A decision is required.',
            '--json',
          ],
          { cwd: sources[0] },
        );
        const decision = JSON.parse(blocked.stdout) as { value: { status: string } };

        assert.equal(decision.value.status, 'needs_decision');
      } finally {
        await service.close();
      }
    });
  },
);
