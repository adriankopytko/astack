import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acceptRunReport,
  verifyImplementation,
  reconcileHook,
  type HostConfigurationPolicy,
  type VerificationRecord,
  hostConfigurationPolicySchema,
  nodeProcessRunner,
  type VerificationDependencies,
  createServiceCoordinator,
  submitImplementation,
  nodeRunArtifactReader,
  handoffRequestSchema,
  inspectImplementationHandoff,
  handoffWriteResultSchema,
  type HandoffDependencies,
  type HandoffView,
  type StateWriteResult,
  type GithubProvider,
  type GithubPublicationReceipt,
  type GithubPullRequest,
  type PushReceipt,
  type RunDependencies,
} from '../../src/index.js';
import { completed, rejected } from '../../src/contracts/operation-result.js';
import { fixture as implementationFixture } from './implementation.js';
import { git } from './service.js';

export function persisted(result: StateWriteResult<HandoffView>): HandoffView {
  handoffWriteResultSchema.parse(result);

  assert.ok(result.outcome === 'persisted', JSON.stringify(result));

  return result.value;
}

export interface VerificationFixtureOptions {
  configure?: (policy: HostConfigurationPolicy) => void;
  verify?: boolean;
}
async function setup(
  context: Parameters<Parameters<typeof implementationFixture>[0]>[0],
  options: VerificationFixtureOptions,
) {
  const submission = await context.prepare();
  const policyPath = join(context.context.state, 'config', submission.projectId + '.json');
  const policy = hostConfigurationPolicySchema.parse(
    JSON.parse(await readFile(policyPath, 'utf8')),
  );
  policy.execution.commands['fixture-check'] = {
    executable: process.execPath,
    args: ['--version'],
  };
  policy.execution.verification = {
    implementer: {
      baseline: ['baseline'],
      checks: {
        baseline: { command: 'fixture-check', timeoutMs: 1000, environment: [], resources: {} },
      },
      lanes: {},
      maxAgeMs: 86400000,
    },
  };
  options.configure?.(policy);
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const submitted = await submitImplementation(submission, context.deps);

  assert.ok(submitted.outcome === 'persisted', JSON.stringify(submitted));

  const job = submitted.value.job;
  const task = job.job.intent.task;

  assert.ok(
    task && typeof task === 'object' && !Array.isArray(task) && typeof task.root === 'string',
  );

  const root = task.root;
  const coordinator = createServiceCoordinator({
    sessionId: 'handoff-fixture',
    dependencies: context.deps,
    runtimes: [context.runtime],
    limits: { global: 1, defaultRole: 1, perRole: {} },
    onFailure: () => assert.fail('Coordinator failed'),
  });
  coordinator.start();

  try {
    await coordinator.idle();
  } finally {
    await coordinator.stop();
  }

  await writeFile(join(root, 'result.txt'), 'Completed fixture implementation\n');
  await writeFile(join(root, '.gitignore'), '.verification.json\n');
  git(root, 'add', 'result.txt', '.gitignore');
  git(root, 'commit', '-m', 'feat: implement fixture');
  const head = git(root, 'rev-parse', 'HEAD');
  const content = '{"result":"passed"}\n';
  const artifact = {
    path: '.verification.json',
    digest: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  };
  await writeFile(join(root, artifact.path), content);
  const runDeps: RunDependencies = {
    ...context.deps,
    runs: context.context.opened.runs,
    artifacts: nodeRunArtifactReader,
    workerInput: context.workerInput,
    targets: { read: async () => assert.fail('No implementation target reads') },
    workerControl: { interrupt: async () => assert.fail('No worker controls') },
  };
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
        branch: job.entry.branch,
        baseCommit: job.entry.commit,
        headCommit: head,
        outcome: 'completed',
        summary: 'Implemented fixture',
        blockers: [],
      },
      artifacts: [artifact],
    },
    runDeps,
  );

  assert.ok(report.outcome === 'persisted' && report.value.report, JSON.stringify(report));

  const verificationDeps: VerificationDependencies = {
    ...context.deps,
    hooks: context.context.opened.hooks,
    verifications: context.context.opened.verifications,
    runs: context.context.opened.runs,
    artifacts: nodeRunArtifactReader,
    workerInput: context.workerInput,
    allocations: context.context.opened.allocations,
    ports: { inspect: async () => completed('free') },
    runner: nodeProcessRunner,
    environment: { read: async () => completed({}) },
    now: Date.now,
  };
  let verification: VerificationRecord | null = null;

  if (options.verify !== false) {
    const observed = await context.deps.git.inspect({ schemaVersion: 1, path: root });
    const verified = await verifyImplementation(
      {
        schemaVersion: 1,
        jobId: job.job.id,
        reportId: report.value.report.id,
        key: 'baseline-verification',
        writersExcluded: true,
      },
      { ...verificationDeps, git: { inspect: async () => observed } },
    );

    assert.ok(
      verified.outcome === 'persisted' && verified.value.status === 'passed',
      JSON.stringify(verified),
    );

    verification = verified.value;

    for (const check of verification.checks) {
      assert.ok(check.hookId);

      const hook = context.context.opened.hooks.read(check.hookId);

      assert.ok(hook.outcome === 'completed' && hook.value);

      const settled = reconcileHook(
        {
          schemaVersion: 1,
          id: hook.value.id,
          expectedRevision: hook.value.revision,
          key: 'fixture-foreground-stopped',
          writersStopped: true,
          servicesStopped: true,
        },
        verificationDeps,
      );

      assert.equal(settled.outcome, 'persisted', JSON.stringify(settled));
    }
  }

  const request = handoffRequestSchema.parse({
    schemaVersion: 1,
    jobId: job.job.id,
    reportId: report.value.report.id,
    key: 'publish-v1',
    publication: {
      schemaVersion: 1,
      kind: 'pull-request',
      target: { host: 'github.com', repository: 'example/project' },
      actor: 'fixture-actor',
      sourceRepository: 'example/project',
      headBranch: submission.branch.slice('refs/heads/'.length),
      headSha: head,
      baseBranch: 'main',
      baseSha: submission.commit,
      title: 'Fixture change',
      body: 'Verification passed.',
      draft: false,
    },
    verification: { source: 'executed', id: verification?.id ?? 'not-run' },
    review: {
      gate: { requiredChecks: ['ci'], overrideReason: null },
      instructionPaths: ['AGENTS.md'],
    },
  });
  const remote = {
    pushCalls: 0,
    postCalls: 0,
    inspectCalls: 0,
    findCalls: 0,
    pushMode: 'success',
    postMode: 'success',
    pushReceipt: null as PushReceipt | null,
    receipt: null as GithubPublicationReceipt | null,
    pr: null as GithubPullRequest | null,
  };
  let sequence = 0;
  const github: GithubProvider = {
    async inspectPullRequest() {
      assert.ok(remote.pr);

      return completed(remote.pr);
    },
    readChecks: async () => assert.fail('Handoff does not gate on CI'),
    discoverPullRequests: async () => assert.fail('No broad discovery'),
    async findPublication() {
      remote.findCalls++;

      return completed(remote.receipt);
    },
    async publish({ publication, marker }) {
      remote.postCalls++;

      assert.equal(publication.kind, 'pull-request');

      if (remote.postMode === 'rejected') {
        return rejected('github_auth_required', 'Fixture preflight rejection');
      }

      if (publication.kind !== 'pull-request') {
        assert.fail('Expected PR');
      }

      const target = { ...publication.target, number: 12, sha: head };
      remote.receipt = {
        schemaVersion: 1,
        kind: 'pull-request',
        marker,
        target,
        id: 12,
        actor: publication.actor,
        observedAt: 1000,
      };
      remote.pr = {
        target,
        baseSha: publication.baseSha,
        baseBranch: publication.baseBranch,
        headBranch: publication.headBranch,
        sourceRepository: publication.sourceRepository,
        state: 'OPEN',
        draft: publication.draft,
        title: publication.title,
        body: `${publication.body}\n\n${marker}`,
        author: publication.actor,
      };

      if (remote.postMode === 'lost') {
        throw new Error('Fixture POST accepted, response lost');
      }

      return completed(remote.receipt);
    },
  };
  const opened = context.context.opened;
  const deps: HandoffDependencies = {
    ...context.deps,
    state: opened.store,
    runs: opened.runs,
    handoffs: opened.handoffs,
    verifications: opened.verifications,
    configuration: context.deps.configuration,
    artifacts: nodeRunArtifactReader,
    workerInput: context.workerInput,
    github,
    now: () => 1000,
    nextId: () => `handoff-controller-${++sequence}`,
    publisher: {
      async inspect() {
        remote.inspectCalls++;

        return completed(remote.pushReceipt);
      },
      async push({ intent }) {
        remote.pushCalls++;

        if (remote.pushMode === 'rejected') {
          return rejected('handoff_blocked', 'Fixture push preflight rejection');
        }

        const receipt = {
          repository: intent.repository,
          branch: intent.branch,
          sha: intent.sha,
          observedAt: 1000,
        };
        remote.pushReceipt = receipt;

        if (remote.pushMode === 'lost') {
          throw new Error('Fixture push accepted, response lost');
        }

        return completed(receipt);
      },
    },
  };
  const input = { schemaVersion: 1, request, writersStopped: true };
  const reconcile = { schemaVersion: 1, jobId: job.job.id, key: request.key, writersStopped: true };
  const inspect = () => {
    const result = inspectImplementationHandoff({ schemaVersion: 1, jobId: job.job.id }, deps);

    assert.ok(result.outcome === 'completed' && result.value, JSON.stringify(result));

    return result.value;
  };

  return {
    context,
    root,
    head,
    job,
    artifact,
    request,
    input,
    reconcile,
    deps,
    remote,
    inspect,
    verificationDeps,
    verification,
  };
}

export type HandoffFixture = Awaited<ReturnType<typeof setup>>;
export async function fixture(
  action: (context: HandoffFixture) => Promise<void>,
  options: VerificationFixtureOptions = {},
) {
  await implementationFixture(async (context) => action(await setup(context, options)));
}
