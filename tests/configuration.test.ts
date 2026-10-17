import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  openSqliteState,
  registerProject,
  createGitInspector,
  nodeProcessRunner,
  nodeCheckoutIdentityReader,
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
  resolveConfiguration,
  acceptConfiguredJob,
  checkConfigurationDispatch,
  inspectStateRecord,
  acceptStateJob,
  hostConfigurationPolicySchema,
  portableConfigurationSchema,
  configurationResultSchema,
  stateJobSchema,
  type ConfigurationDependencies,
  type ConfigurationResolution,
  type HostConfigurationPolicy,
  type OperationResult,
  type StateJob,
} from '../src/index.js';
import { configurationDigest, mergeConfiguration } from '../src/core/configuration.js';

const gitPath = spawnSync('/usr/bin/which', ['git'], {
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
}).stdout.trim();
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(gitPath, ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

function resolution(result: OperationResult<ConfigurationResolution>): ConfigurationResolution {
  configurationResultSchema.parse(result);

  if (result.outcome !== 'completed') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

async function fixture(
  action: (context: {
    root: string;
    source: string;
    state: string;
    skillPath: string;
    policyPath: string;
    policy: HostConfigurationPolicy;
    request: { schemaVersion: 1; projectId: string; role: string };
    deps: ConfigurationDependencies;
    opened: Extract<Awaited<ReturnType<typeof openSqliteState>>, { outcome: 'opened' }>;
    job: StateJob;
    save: (policy?: unknown) => Promise<void>;
    proposal: (settings: unknown) => Promise<void>;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astack-config-')));
  const source = join(root, 'source');
  const state = join(root, 'state');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'README.md'), 'fixture\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'fixture');
  const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: state });

  if (opened.outcome !== 'opened') {
    assert.fail(JSON.stringify(opened));
  }

  const base = {
    registry: opened.registry,
    identity: nodeCheckoutIdentityReader,
    git: createGitInspector({ executable: gitPath, runner: nodeProcessRunner }),
  };

  try {
    const registration = await registerProject(
      { schemaVersion: 1, path: source, projectId: 'fixture-project' },
      {
        ...base,
        nextId: (kind) => `${kind}-fixture`,
        now: () => 1000,
      },
    );

    if (registration.outcome !== 'persisted') {
      assert.fail(JSON.stringify(registration));
    }

    const skillPath = join(root, 'role-skill.md');
    await writeFile(skillPath, 'Approved fixture skill\n', { mode: 0o600 });
    const digest = createHash('sha256')
      .update(await readFile(skillPath))
      .digest('hex');

    const policy = hostConfigurationPolicySchema.parse({
      schemaVersion: 1,
      projectId: registration.value.project.id,
      repositoryId: registration.value.repository.id,
      revision: 'v1',
      project: {
        roles: {
          implementer: {
            runtime: 'fixture',
            command: 'worker',
            skills: [{ id: 'implementation', version: 'v1', digest }],
          },
        },
      },
      execution: {
        enabled: true,
        allowedRuntimes: ['fixture'],
        allowedEnvironment: [],
        commands: { worker: { executable: process.execPath, args: ['--version'] } },
        skills: [{ id: 'implementation', version: 'v1', digest, path: skillPath }],
      },
    });
    const policyPath = join(state, 'config', `${policy.projectId}.json`);
    const save = async (value: unknown = policy) => {
      await mkdir(join(state, 'config'), { mode: 0o700, recursive: true });
      await writeFile(policyPath, JSON.stringify(value), { mode: 0o600 });
    };

    const proposal = async (settings: unknown) => {
      await mkdir(join(source, '.astack'), { recursive: true });
      await writeFile(
        join(source, '.astack/project.json'),
        JSON.stringify({ schemaVersion: 1, settings }),
      );
    };

    const deps: ConfigurationDependencies = {
      ...base,
      configuration: createNodeConfigurationReader(state),
      prerequisites: createNodeConfigurationProbe(() => false),
    };
    const job = stateJobSchema.parse({
      id: 'configured-job',
      projectId: policy.projectId,
      repositoryId: policy.repositoryId,
      checkoutId: registration.value.checkout.id,
      requester: 'fixture',
      operation: 'implement',
      idempotencyKey: 'fixture-key',
      createdAt: 1000,
      intent: { task: 'fixture' },
    });
    await save();
    await action({
      root,
      source,
      state,
      skillPath,
      policyPath,
      policy,
      request: { schemaVersion: 1, projectId: policy.projectId, role: 'implementer' },
      deps,
      opened,
      job,
      save,
      proposal,
    });
  } finally {
    opened.store.close();
    await rm(root, { recursive: true, force: true });
  }
}

await test('configuration schema rejects host permissions and invalid portable shapes', () => {
  for (const value of [
    null,
    { schemaVersion: 2, settings: {} },
    { schemaVersion: 1, settings: {}, execution: { enabled: true } },
    { schemaVersion: 1, settings: { commands: { worker: '/bin/sh' } } },
    { schemaVersion: 1, settings: { roles: { implementer: { timeoutMs: 0 } } } },
    { schemaVersion: 1, settings: { roles: { constructor: {} } } },
  ]) {
    assert.equal(portableConfigurationSchema.safeParse(value).success, false);
  }

  assert.equal(
    portableConfigurationSchema.safeParse({ schemaVersion: 1, settings: {} }).success,
    true,
  );
});

await test('merge precedence preserves object fields, replaces arrays, and records leaf provenance', () => {
  const merged = mergeConfiguration({
    user: {
      roles: {
        implementer: { runtime: 'user-runtime', timeoutMs: 1000, environment: ['FIRST', 'SECOND'] },
      },
    },
    project: {
      roles: { implementer: { timeoutMs: 2000, environment: ['PROJECT'] } },
      hooks: { verify: 'verify' },
    },
    local: { roles: { implementer: { timeoutMs: 3000 } } },
    request: {
      roles: { implementer: { timeoutMs: 4000, environment: [] } },
      hooks: { verify: null },
    },
  });

  assert.equal(merged.effective.roles.implementer?.runtime, 'user-runtime');
  assert.equal(merged.effective.roles.implementer?.timeoutMs, 4000);
  assert.deepEqual(merged.effective.roles.implementer?.environment, []);
  assert.deepEqual(merged.effective.hooks, { setup: null, verify: null, teardown: null });
  assert.equal(
    merged.provenance.find((entry) => entry.path === 'roles.implementer.runtime')?.source,
    'user',
  );
  assert.equal(
    merged.provenance.find((entry) => entry.path === 'roles.implementer.timeoutMs')?.source,
    'request',
  );
  assert.equal(
    merged.provenance.find((entry) => entry.path === 'roles.reviewer.timeoutMs')?.source,
    'defaults',
  );
  assert.equal(configurationDigest({ a: 1, b: [2, 3] }), configurationDigest({ b: [2, 3], a: 1 }));
  assert.notEqual(configurationDigest([2, 3]), configurationDigest([3, 2]));
});

await test('approved configuration resolves without hooks or executing any configured command', async () => {
  await fixture(async ({ request, deps, policy, save, root, proposal }) => {
    policy.execution.commands.worker = {
      executable: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'should-not-exist'))}, 'effect')`,
      ],
    };
    await save();
    await proposal(policy.project);
    const value = resolution(await resolveConfiguration(request, deps));

    assert.equal(value.status, 'ready');
    assert.equal(value.proposal, 'matches');
    assert.deepEqual(value.snapshot?.effective.hooks, {
      setup: null,
      verify: null,
      teardown: null,
    });
    assert.equal(value.snapshot?.skills[0]?.version, 'v1');
    assert.equal(JSON.stringify(value).includes('require('), false);

    await assert.rejects(readFile(join(root, 'should-not-exist')));
  });
});

await test('missing policy blocks and read-only resolution does not initialize host configuration', async () => {
  await fixture(async ({ request, deps, policyPath, state }) => {
    await rm(join(state, 'config'), { recursive: true });
    const value = resolution(await resolveConfiguration(request, deps));

    assert.equal(value.status, 'blocked');
    assert.equal(value.snapshot, null);
    assert.equal(value.diagnostics[0]?.code, 'policy_missing');

    await assert.rejects(readFile(policyPath));
  });
});

await test('invalid policy and malformed proposals return sanitized schema errors', async () => {
  await fixture(async ({ request, deps, save, policy, source, proposal }) => {
    await save({ ...policy, token: 'fixture-private-token' });
    const invalid = await resolveConfiguration(request, deps);

    assert.equal(invalid.outcome, 'rejected');
    assert.equal(JSON.stringify(invalid).includes('fixture-private-token'), false);

    await save(null);
    const nullPolicy = await resolveConfiguration(request, deps);

    assert.equal(nullPolicy.outcome, 'rejected');

    await save();
    await proposal({ execution: { enabled: true } });
    const proposed = await resolveConfiguration(request, deps);

    assert.equal(proposed.outcome, 'rejected');

    await writeFile(join(source, '.astack/project.json'), '{ malformed');
    const malformed = await resolveConfiguration(request, deps);

    assert.equal(malformed.outcome, 'rejected');
    assert.equal(JSON.stringify(malformed).includes('malformed'), false);
  });
});

await test('PR-proposed permission escalation never becomes effective execution policy', async () => {
  await fixture(async ({ request, deps, proposal, policy }) => {
    await proposal({ roles: { implementer: { command: 'unapproved-shell' } } });
    const value = resolution(await resolveConfiguration(request, deps));

    assert.equal(value.status, 'blocked');
    assert.equal(value.proposal, 'changed');
    assert.equal(value.snapshot?.effective.roles.implementer?.command, 'worker');
    assert.equal(
      value.diagnostics.some((entry) => entry.code === 'proposal_changed'),
      true,
    );
    assert.equal(value.snapshot?.policyDigest, configurationDigest(policy));
  });
});

await test('request overrides cannot bypass host timeout, required hooks, commands, environment, or skill approvals', async () => {
  await fixture(async ({ request, deps, policy, save }) => {
    policy.project.hooks = { verify: 'worker' };
    policy.execution.requiredHooks.verify = 'worker';
    await save();
    const value = resolution(
      await resolveConfiguration(
        {
          ...request,
          request: {
            roles: {
              implementer: {
                runtime: 'other',
                command: 'shell',
                timeoutMs: 600_000,
                environment: ['UNAPPROVED'],
                skills: [{ id: 'other', version: 'v1', digest: 'a'.repeat(64) }],
              },
            },
            hooks: { verify: null },
          },
        },
        deps,
      ),
    );
    const codes = new Set(value.diagnostics.map((entry) => entry.code));

    assert.equal(value.status, 'blocked');

    for (const code of [
      'runtime_not_allowed',
      'command_not_allowed',
      'environment_not_allowed',
      'skill_not_approved',
      'timeout_not_allowed',
      'required_hook_changed',
    ]) {
      assert.equal(codes.has(code as (typeof value.diagnostics)[number]['code']), true, code);
    }
  });
});

await test('missing executable, missing environment, and changed skill bytes give actionable prerequisites', async () => {
  await fixture(async ({ request, deps, policy, save, root, skillPath }) => {
    policy.execution.commands.worker = { executable: join(root, 'missing-binary'), args: [] };
    policy.execution.allowedEnvironment = ['FIXTURE_TOKEN'];
    policy.project.roles = {
      implementer: { ...policy.project.roles?.implementer, environment: ['FIXTURE_TOKEN'] },
    };
    await save();
    await writeFile(skillPath, 'edited skill\n');
    const value = resolution(await resolveConfiguration(request, deps));
    const codes = value.diagnostics.map((entry) => entry.code);

    assert.equal(value.status, 'blocked');
    assert.ok(codes.includes('executable_missing'));
    assert.ok(codes.includes('environment_missing'));
    assert.ok(codes.includes('skill_unavailable'));
    assert.ok(value.diagnostics.every((entry) => entry.nextStep.length > 10));
    assert.equal(JSON.stringify(value).includes('edited skill'), false);
    assert.equal(JSON.stringify(value).includes(join(root, 'missing-binary')), false);
  });
});

await test('configured job acceptance stores immutable policy provenance and exact skill pins with idempotency', async () => {
  await fixture(async ({ job, request, deps, opened, policy, save, state }) => {
    const dependencies = { ...deps, store: opened.store };
    const accepted = await acceptConfiguredJob(
      { schemaVersion: 1, job, role: request.role, request: {} },
      dependencies,
    );

    assert.equal(accepted.outcome, 'persisted');

    if (accepted.outcome !== 'persisted') {
      assert.fail(JSON.stringify(accepted));
    }

    assert.equal(accepted.value.configuration?.policyRevision, 'v1');
    assert.equal(
      accepted.value.configuration?.skills[0]?.digest,
      policy.execution.skills[0]?.digest,
    );
    assert.ok(accepted.value.configuration?.provenance.length);

    const repeated = await acceptConfiguredJob(
      { schemaVersion: 1, job, role: request.role, request: {} },
      dependencies,
    );

    assert.equal(repeated.outcome === 'persisted' && repeated.disposition, 'existing');

    policy.revision = 'v2';
    await save();
    const changed = await acceptConfiguredJob(
      { schemaVersion: 1, job, role: request.role, request: {} },
      dependencies,
    );

    assert.equal(changed.outcome === 'rejected' && changed.error.code, 'state_conflict');

    const saved = inspectStateRecord({ schemaVersion: 1, entity: 'job', id: job.id }, opened.store);

    assert.equal(
      saved.outcome === 'completed' &&
        saved.value?.entity === 'job' &&
        saved.value.record.configuration?.policyRevision,
      'v1',
    );

    const reopened = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      stateDirectory: state,
    });

    if (reopened.outcome !== 'opened') {
      assert.fail(JSON.stringify(reopened));
    }

    try {
      const persisted = inspectStateRecord(
        { schemaVersion: 1, entity: 'job', id: job.id },
        reopened.store,
      );

      assert.deepEqual(persisted, saved);
    } finally {
      reopened.store.close();
    }
  });
});

await test('versioned configuration operations reject malformed requests and unknown roles cannot accept jobs', async () => {
  await fixture(async ({ job, request, deps, opened }) => {
    const unsupported = await resolveConfiguration({ ...request, schemaVersion: 2 }, deps);
    const invalidJob = await acceptConfiguredJob(
      { schemaVersion: 2, job, role: request.role },
      { ...deps, store: opened.store },
    );
    const invalidDispatch = await checkConfigurationDispatch({ schemaVersion: 2, job }, deps);

    for (const result of [unsupported, invalidJob, invalidDispatch]) {
      assert.equal(
        result.outcome === 'rejected' && result.error.code,
        'unsupported_contract_version',
      );
    }

    const unknown = resolution(
      await resolveConfiguration({ ...request, role: 'unknown-role' }, deps),
    );

    assert.equal(unknown.status, 'blocked');
    assert.ok(unknown.diagnostics.some((entry) => entry.code === 'role_missing'));

    const blocked = await acceptConfiguredJob(
      { schemaVersion: 1, job, role: 'unknown-role' },
      { ...deps, store: opened.store },
    );

    assert.equal(blocked.outcome === 'rejected' && blocked.error.code, 'configuration_blocked');

    const saved = inspectStateRecord({ schemaVersion: 1, entity: 'job', id: job.id }, opened.store);

    assert.equal(saved.outcome === 'completed' && saved.value, null);
  });
});

await test('dispatch gate refreshes permissions even when the human policy revision is unchanged', async () => {
  await fixture(async ({ job, request, deps, opened, policy, save }) => {
    const accepted = await acceptConfiguredJob(
      { schemaVersion: 1, job, role: request.role, request: {} },
      { ...deps, store: opened.store },
    );

    if (accepted.outcome !== 'persisted') {
      assert.fail(JSON.stringify(accepted));
    }

    const ready = resolution(
      await checkConfigurationDispatch({ schemaVersion: 1, job: accepted.value }, deps),
    );

    assert.equal(ready.status, 'ready');

    policy.execution.enabled = false;
    await save();
    const revoked = resolution(
      await checkConfigurationDispatch({ schemaVersion: 1, job: accepted.value }, deps),
    );

    assert.equal(revoked.status, 'blocked');
    assert.ok(revoked.diagnostics.some((entry) => entry.code === 'execution_disabled'));
    assert.ok(revoked.diagnostics.some((entry) => entry.code === 'policy_changed'));

    policy.execution.enabled = true;
    policy.execution.commands.worker = { executable: process.execPath, args: ['--help'] };
    await save();
    const changedCommand = resolution(
      await checkConfigurationDispatch({ schemaVersion: 1, job: accepted.value }, deps),
    );

    assert.equal(changedCommand.status, 'blocked');
    assert.ok(changedCommand.diagnostics.some((entry) => entry.code === 'policy_changed'));
  });
});

await test('dispatch rechecks prerequisite bytes and environment without mutating the saved snapshot', async () => {
  await fixture(async ({ job, request, deps, opened, skillPath, policy, save }) => {
    policy.execution.allowedEnvironment = ['FIXTURE_TOKEN'];
    policy.project.roles = {
      implementer: { ...policy.project.roles?.implementer, environment: ['FIXTURE_TOKEN'] },
    };
    await save();
    let present = true;
    const controlled = {
      ...deps,
      prerequisites: createNodeConfigurationProbe(() => present),
      store: opened.store,
    };
    const accepted = await acceptConfiguredJob(
      { schemaVersion: 1, job, role: request.role, request: {} },
      controlled,
    );

    if (accepted.outcome !== 'persisted') {
      assert.fail(JSON.stringify(accepted));
    }

    present = false;
    await writeFile(skillPath, 'changed after acceptance');
    const blocked = resolution(
      await checkConfigurationDispatch({ schemaVersion: 1, job: accepted.value }, controlled),
    );

    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.diagnostics.some((entry) => entry.code === 'skill_unavailable'));
    assert.ok(blocked.diagnostics.some((entry) => entry.code === 'environment_missing'));
    assert.equal(blocked.snapshot?.policyDigest, accepted.value.configuration?.policyDigest);
  });
});

await test('legacy jobs need fresh acceptance and requesters cannot inject trusted snapshots', async () => {
  await fixture(async ({ job, request, deps, opened }) => {
    const legacy = acceptStateJob({ schemaVersion: 1, job }, opened.store);

    assert.equal(legacy.outcome, 'persisted');

    const blocked = resolution(await checkConfigurationDispatch({ schemaVersion: 1, job }, deps));

    assert.equal(blocked.diagnostics[0]?.code, 'snapshot_missing');

    const current = resolution(await resolveConfiguration(request, deps));
    const forged = await acceptConfiguredJob(
      {
        schemaVersion: 1,
        job: { ...job, configuration: current.snapshot },
        role: request.role,
        request: {},
      },
      { ...deps, store: opened.store },
    );

    assert.equal(forged.outcome, 'rejected');
  });
});

await test('filesystem policy and proposal reads reject links, public policy files, and repository-hosted authority', async () => {
  await fixture(async ({ request, deps, policyPath, source, policy, save }) => {
    await chmod(policyPath, 0o644);
    const publicPolicy = await resolveConfiguration(request, deps);

    assert.equal(
      publicPolicy.outcome === 'rejected' && publicPolicy.error.code,
      'configuration_unsafe',
    );

    await chmod(policyPath, 0o600);
    await rm(policyPath);
    await symlink(join(source, 'README.md'), policyPath);
    const linked = await resolveConfiguration(request, deps);

    assert.equal(linked.outcome === 'rejected' && linked.error.code, 'configuration_unsafe');

    await rm(policyPath);
    await save();
    await mkdir(join(source, 'config'), { mode: 0o700 });
    await writeFile(join(source, 'config', `${policy.projectId}.json`), JSON.stringify(policy), {
      mode: 0o600,
    });
    const repositoryPolicy = await resolveConfiguration(request, {
      ...deps,
      configuration: createNodeConfigurationReader(source),
    });

    assert.equal(
      repositoryPolicy.outcome === 'rejected' && repositoryPolicy.error.code,
      'configuration_unsafe',
    );

    await mkdir(join(source, '.astack'));
    await symlink(policyPath, join(source, '.astack/project.json'));
    const linkedProposal = await resolveConfiguration(request, deps);

    assert.equal(
      linkedProposal.outcome === 'rejected' && linkedProposal.error.code,
      'configuration_unsafe',
    );
  });
});

await test('configuration is bound to project/repository identity and cancellation causes no acceptance', async () => {
  await fixture(async ({ request, deps, policy, save, job, opened }) => {
    await save({ ...policy, repositoryId: 'different-repository' });
    const mismatch = await resolveConfiguration(request, deps);

    assert.equal(
      mismatch.outcome === 'rejected' && mismatch.error.code,
      'project_selector_conflict',
    );

    await save();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await acceptConfiguredJob(
      { schemaVersion: 1, job, role: request.role, request: {} },
      { ...deps, store: opened.store },
      controller.signal,
    );

    assert.equal(cancelled.outcome === 'rejected' && cancelled.error.code, 'cancelled');

    const saved = inspectStateRecord({ schemaVersion: 1, entity: 'job', id: job.id }, opened.store);

    assert.equal(saved.outcome === 'completed' && saved.value, null);
  });
});

await test('compiled configuration CLI works from neutral cwd, reports blocking reasons, and keeps host arguments private', async () => {
  await fixture(async ({ root, state, policy, save }) => {
    policy.execution.commands.worker = {
      executable: process.execPath,
      args: ['fixture-private-argument'],
    };
    await save();
    const run = () =>
      spawnSync(
        process.execPath,
        [
          cli,
          '--state-directory',
          state,
          '--git-executable',
          gitPath,
          'config',
          'inspect',
          '--project',
          policy.projectId,
          '--json',
        ],
        { cwd: root, env: {}, encoding: 'utf8', timeout: 20_000 },
      );
    const ready = run();

    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stderr, '');
    assert.equal(ready.stdout.includes('fixture-private-argument'), false);
    assert.equal(
      resolution(configurationResultSchema.parse(JSON.parse(ready.stdout) as unknown)).status,
      'ready',
    );

    policy.execution.enabled = false;
    await save();
    const blocked = run();

    assert.equal(blocked.status, 1);
    assert.equal(
      resolution(configurationResultSchema.parse(JSON.parse(blocked.stdout) as unknown))
        .diagnostics[0]?.code,
      'execution_disabled',
    );
  });
});
