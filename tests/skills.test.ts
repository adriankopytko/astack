import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  access,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createBundledSkillReader,
  nodeSkillDirectories,
  nodeManagedFileStore,
  createNodeManagedFileStore,
  installSkills,
  inspectSkills,
  writeManagedFile,
  skillCatalogResultSchema,
  skillsInstallResultSchema,
  skillsInspectResultSchema,
  implementationWorkerReportSchema,
  reviewWorkerReportSchema,
  type SkillBundle,
  type SkillsDependencies,
  type SkillsInstallResult,
} from '../src/index.js';
import { completed } from '../src/contracts/operation-result.js';
import { createProgram } from '../src/cli/program.js';
import type { Command } from 'commander';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
async function fixture(
  action: (root: string, deps: SkillsDependencies, bundle: SkillBundle) => Promise<void>,
) {
  const temporary = await mkdtemp(join(tmpdir(), 'astack-skills-'));
  const root = join(temporary, 'skills');
  const bundleReader = createBundledSkillReader();
  const result = await bundleReader.read();

  assert.ok(result.outcome === 'completed', JSON.stringify(result));

  try {
    await action(
      root,
      { bundle: bundleReader, files: nodeManagedFileStore, directories: nodeSkillDirectories },
      result.value,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function installed(result: SkillsInstallResult) {
  skillsInstallResultSchema.parse(result);

  assert.ok(
    result.outcome === 'installed' || result.outcome === 'unchanged',
    JSON.stringify(result),
  );

  return result;
}

await test('skill inspection makes no files; explicit installation creates private discoverable assets and repeat preserves inodes/provenance', async () => {
  await fixture(async (root, deps, bundle) => {
    const inspected = await inspectSkills({ schemaVersion: 1, root }, deps);
    skillsInspectResultSchema.parse(inspected);

    assert.ok(inspected.outcome === 'completed');
    assert.equal(inspected.value.available, false);

    await assert.rejects(access(root), { code: 'ENOENT' });

    const first = installed(await installSkills({ schemaVersion: 1, root }, deps));
    const before = [];

    assert.equal(first.outcome, 'installed');
    assert.equal(first.view.available, true);

    for (const asset of bundle.catalog.skills) {
      const file = join(root, asset.path);
      before.push(await stat(file));

      assert.equal(
        await readFile(file, 'utf8'),
        bundle.contents.find((item) => item.id === asset.id)!.content,
      );
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal(
        first.view.skills.find((entry) => entry.asset.id === asset.id)?.record?.owner,
        `astack:skill:${asset.id}`,
      );
    }

    const repeated = installed(await installSkills({ schemaVersion: 1, root }, deps));

    assert.equal(repeated.outcome, 'unchanged');
    assert.deepEqual(repeated.view, first.view);

    for (const [index, asset] of bundle.catalog.skills.entries()) {
      assert.equal((await stat(join(root, asset.path))).ino, before[index]!.ino);
    }
  });
});

await test('authored collisions block the whole selection before writes; explicit smaller selection preserves unrelated skills/settings', async () => {
  await fixture(async (root, deps) => {
    await mkdir(join(root, 'astack-reviewer'), { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'custom-skill'));
    await writeFile(join(root, 'astack-reviewer', 'SKILL.md'), 'Authored review guidance\n');
    await writeFile(join(root, 'custom-skill', 'SKILL.md'), 'Custom guidance\n');
    await writeFile(join(root, 'settings.toml'), 'authored = true\n');
    const blocked = await installSkills({ schemaVersion: 1, root }, deps);

    assert.equal(blocked.outcome, 'blocked');

    if (blocked.outcome === 'blocked') {
      assert.equal(blocked.writes.length, 0);
      assert.equal(
        blocked.view.skills.find((entry) => entry.asset.id === 'reviewer')?.reason,
        'unowned_file',
      );
    }

    await assert.rejects(access(join(root, 'astack-orchestrator')), { code: 'ENOENT' });
    await assert.rejects(access(join(root, '.astack-managed')), { code: 'ENOENT' });

    installed(await installSkills({ schemaVersion: 1, root, skills: ['orchestrator'] }, deps));

    assert.equal(
      await readFile(join(root, 'astack-reviewer', 'SKILL.md'), 'utf8'),
      'Authored review guidance\n',
    );
    assert.equal(
      await readFile(join(root, 'custom-skill', 'SKILL.md'), 'utf8'),
      'Custom guidance\n',
    );
    assert.equal(await readFile(join(root, 'settings.toml'), 'utf8'), 'authored = true\n');
  });
});

await test('a nonempty authored role directory without SKILL.md is preserved rather than adopted', async () => {
  await fixture(async (root, deps) => {
    await mkdir(join(root, 'astack-reviewer'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'astack-reviewer', 'notes.md'), 'Incomplete authored skill\n');
    const blocked = await installSkills({ schemaVersion: 1, root }, deps);

    assert.ok(blocked.outcome === 'blocked');
    assert.equal(
      blocked.view.skills.find((entry) => entry.asset.id === 'reviewer')?.reason,
      'unowned_skill_directory',
    );
    assert.deepEqual(await readdir(join(root, 'astack-reviewer')), ['notes.md']);

    await assert.rejects(access(join(root, 'astack-implementer')), { code: 'ENOENT' });
  });
});

await test('owned versions update through managed writes, while edits and deleted owned directories block reinstall', async () => {
  await fixture(async (root, deps, original) => {
    installed(await installSkills({ schemaVersion: 1, root }, deps));
    const bundle = structuredClone(original);
    bundle.catalog.version = '1.0.1';

    for (const asset of bundle.catalog.skills) {
      const file = bundle.contents.find((item) => item.id === asset.id)!;
      file.content =
        file.content.replaceAll('1.0.0', '1.0.1') + '\nA versioned fixture clarification.\n';
      asset.version = '1.0.1';
      asset.sha256 = hash(file.content);
    }

    const update = { ...deps, bundle: { read: async () => completed(bundle) } };
    const before = await inspectSkills({ schemaVersion: 1, root }, update);

    assert.ok(before.outcome === 'completed');
    assert.ok(before.value.skills.every((entry) => entry.state === 'outdated'));

    const upgraded = installed(await installSkills({ schemaVersion: 1, root }, update));

    assert.equal(upgraded.view.catalogVersion, '1.0.1');
    assert.ok(upgraded.view.skills.every((entry) => entry.record?.assetVersion === '1.0.1'));

    await writeFile(join(root, 'astack-implementer', 'SKILL.md'), 'User edits must survive\n');
    const blocked = await installSkills({ schemaVersion: 1, root }, update);

    assert.equal(blocked.outcome, 'blocked');
    assert.equal(
      await readFile(join(root, 'astack-implementer', 'SKILL.md'), 'utf8'),
      'User edits must survive\n',
    );

    await rm(join(root, 'astack-reviewer'), { recursive: true });
    const missingOwned = await installSkills(
      { schemaVersion: 1, root, skills: ['reviewer'] },
      update,
    );

    assert.equal(missingOwned.outcome, 'blocked');

    await assert.rejects(access(join(root, 'astack-reviewer', 'SKILL.md')), { code: 'ENOENT' });
  });
});

await test('pending publication is retained, blocks retries and does not install the remaining roles', async () => {
  await fixture(async (root, deps) => {
    const files = createNodeManagedFileStore({
      onProgress: async (progress) => {
        if (progress.phase === 'published') {
          throw new Error('fixture publication receipt lost');
        }
      },
    });
    const first = await installSkills({ schemaVersion: 1, root }, { ...deps, files });

    assert.ok(first.outcome === 'pending', JSON.stringify(first));
    assert.equal(first.writes.length, 1);
    assert.equal(first.view.skills[0]?.state, 'pending');

    const snapshot = await readdir(join(root, '.astack-managed'));
    const repeated = await installSkills({ schemaVersion: 1, root }, deps);

    assert.ok(repeated.outcome === 'pending');
    assert.equal(repeated.writes.length, 0);
    assert.deepEqual(await readdir(join(root, '.astack-managed')), snapshot);

    await assert.rejects(access(join(root, 'astack-reviewer', 'SKILL.md')), { code: 'ENOENT' });

    assert.doesNotMatch(JSON.stringify(first), /fixture publication receipt lost/);
  });
});

await test('a throwing publication port preserves uncertainty and exact attempted role even after a file committed', async () => {
  await fixture(async (root, deps) => {
    const first = await installSkills(
      { schemaVersion: 1, root },
      {
        ...deps,
        files: {
          inspect: (request) => deps.files.inspect(request),
          async write(request, signal) {
            await deps.files.write(request, signal);

            throw new Error('private injected failure');
          },
        },
      },
    );

    assert.ok(first.outcome === 'pending');
    assert.deepEqual(first.writes, [{ id: 'orchestrator', result: null }]);
    assert.equal(first.view.skills[0]?.state, 'current');

    await assert.rejects(access(join(root, 'astack-implementer', 'SKILL.md')), { code: 'ENOENT' });

    assert.doesNotMatch(JSON.stringify(first), /private injected failure/);
  });
});

await test('foreign ownership and symlinked role directories cannot redirect or authorize installation', async () => {
  await fixture(async (root, deps, bundle) => {
    await mkdir(join(root, 'astack-orchestrator'), { recursive: true, mode: 0o700 });
    const first = bundle.contents[0]!;
    await writeManagedFile(
      {
        schemaVersion: 1,
        root,
        path: 'astack-orchestrator/SKILL.md',
        owner: 'other:owner',
        assetVersion: '1.0.0',
        content: first.content,
        mode: 0o600,
      },
      deps.files,
    );
    const blocked = await installSkills({ schemaVersion: 1, root }, deps);

    assert.ok(blocked.outcome === 'blocked');
    assert.equal(blocked.view.skills[0]?.reason, 'owner_mismatch');
  });
  await fixture(async (root, deps) => {
    await mkdir(root, { mode: 0o700 });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'astack-orchestrator'));
    const blocked = await installSkills({ schemaVersion: 1, root }, deps);

    assert.ok(blocked.outcome === 'rejected' && blocked.error.code === 'skills_unavailable');
    assert.deepEqual(await readdir(outside), []);

    await assert.rejects(access(join(root, '.astack-managed')), { code: 'ENOENT' });
  });
});

await test('invalid versions, duplicate roles, tampered bundled bytes and cancellation perform no directory setup', async () => {
  await fixture(async (root, deps, bundle) => {
    for (const input of [
      { schemaVersion: 2, root },
      { schemaVersion: 1, root, skills: ['reviewer', 'reviewer'] },
      { schemaVersion: 1, root, skills: ['unknown'] },
    ]) {
      assert.equal((await installSkills(input, deps)).outcome, 'rejected');
    }

    const changed = structuredClone(bundle);
    changed.contents[0]!.content += '\nUnpinned content\n';
    const rejected = await installSkills(
      { schemaVersion: 1, root },
      { ...deps, bundle: { read: async () => completed(changed) } },
    );

    assert.ok(rejected.outcome === 'rejected' && rejected.error.code === 'skill_bundle_invalid');
    assert.equal(
      (await installSkills({ schemaVersion: 1, root }, deps, AbortSignal.abort())).outcome,
      'rejected',
    );

    await assert.rejects(access(root), { code: 'ENOENT' });
  });
});

function verifyCommand(example: string, program: Command) {
  const tokens = example.split(/\s+/).slice(1);
  let command = program;

  while (tokens.length && !tokens[0]!.startsWith('-')) {
    const child = command.commands.find((item) => item.name() === tokens[0]);

    if (!child) {
      assert.ok(command.registeredArguments.length > 0, `Unknown command in guide: ${example}`);

      tokens.shift();

      break;
    }

    command = child;
    tokens.shift();
  }

  while (tokens.length) {
    const flag = tokens.shift()!;
    const option = [...command.options, ...program.options].find(
      (item) => item.long === flag || item.short === flag,
    );

    assert.ok(option || flag === '--help', `Unknown option ${flag} in ${example}`);

    if (option?.required || option?.optional) {
      assert.ok(tokens.length > 0, `Missing option value in ${example}`);

      tokens.shift();
    }
  }
}

await test('focused guide command references resolve to actual CLI commands/options, and report examples satisfy worker contracts', async () => {
  const bundle = await createBundledSkillReader().read();

  assert.ok(bundle.outcome === 'completed');

  const program = createProgram('0.0.0');

  for (const file of bundle.value.contents) {
    const asset = bundle.value.catalog.skills.find((item) => item.id === file.id)!;

    assert.ok(
      file.content.startsWith(`---\nname: ${asset.name}\ndescription: ${asset.description}\n`),
    );
    assert.ok(file.content.includes(`asset-version: '${asset.version}'`));

    for (const match of file.content.matchAll(/`(astack [^`\n]+)`/g)) {
      verifyCommand(match[1]!, program);
    }
  }

  const implementation = bundle.value.contents.find((entry) => entry.id === 'implementer')!.content;
  const example = implementation.match(/```json\n([\s\S]+?)\n```/)![1]!;
  const report = JSON.parse(
    example.replaceAll(/<[^>]+>/g, (placeholder) =>
      placeholder.includes('sha') ? 'a'.repeat(40) : 'fixture',
    ),
  ) as unknown;

  implementationWorkerReportSchema.parse(report);
  const finding = JSON.parse(
    bundle.value.contents
      .find((entry) => entry.id === 'reviewer')!
      .content.match(/```json\n([\s\S]+?)\n```/)![1]!,
  ) as unknown;
  const target = {
    host: 'github.com',
    repository: 'example/project',
    number: 1,
    sha: 'a'.repeat(40),
  };
  const gate = { requiredChecks: [], overrideReason: null };
  const snapshot = {
    target,
    baseSha: 'b'.repeat(40),
    state: 'OPEN',
    draft: false,
    sourceRepository: 'example/project',
    checks: [],
    observedAt: 1,
  };
  reviewWorkerReportSchema.parse({
    schemaVersion: 1,
    jobId: 'job-1',
    attemptId: 'attempt-1',
    projectId: 'project-1',
    checkoutId: 'checkout-1',
    target,
    outcome: 'reviewed',
    summary: 'Reviewed the assigned scope.',
    findings: [finding],
    blockers: [],
    gate,
    acceptanceSnapshot: snapshot,
    currentSnapshot: null,
  });
});

await test(
  'packed CLI resolves all role assets outside checkout and installs at isolated user scope without changing agent settings',
  { timeout: 60000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'astack-skill-pack-'));

    try {
      const archive = join(temporary, 'astack.tgz');
      const packed = spawnSync('pnpm', ['pack', '--out', archive], {
        cwd: sourceRoot,
        encoding: 'utf8',
        timeout: 30000,
      });

      assert.equal(packed.status, 0, packed.stderr);

      const extracted = spawnSync('tar', ['-xzf', archive, '-C', temporary], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(extracted.status, 0, extracted.stderr);

      const contents = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });

      assert.doesNotMatch(contents.stdout, /package\/(?:\.planning|src|tests|tools)\//);

      await symlink(join(sourceRoot, 'node_modules'), join(temporary, 'package', 'node_modules'));
      const entry = join(temporary, 'package', 'dist', 'cli', 'main.js');
      const home = join(temporary, 'codex');
      const env = { ...process.env, CODEX_HOME: home };
      const call = (...args: string[]) =>
        spawnSync(process.execPath, [entry, ...args], {
          cwd: temporary,
          env,
          encoding: 'utf8',
          timeout: 15000,
        });
      const catalog = call('skills', 'list', '--json');

      assert.equal(catalog.status, 0, catalog.stderr);

      skillCatalogResultSchema.parse(JSON.parse(catalog.stdout));

      for (const id of ['orchestrator', 'implementer', 'reviewer']) {
        const shown = call('skills', 'show', id);
        const expected = await readFile(
          join(sourceRoot, 'skills', `astack-${id}`, 'SKILL.md'),
          'utf8',
        );

        assert.equal(shown.status, 0, shown.stderr);
        assert.equal(shown.stdout, expected);
      }

      const canonical = call('--skill');

      assert.equal(canonical.status, 0, canonical.stderr);
      assert.equal(
        canonical.stdout,
        await readFile(join(sourceRoot, 'skills', 'astack-cli', 'SKILL.md'), 'utf8'),
      );

      const inspected = call('skills', 'inspect', '--json');

      assert.equal(inspected.status, 0, inspected.stderr);

      await assert.rejects(access(home), { code: 'ENOENT' });

      await mkdir(home, { mode: 0o700 });
      await writeFile(join(home, 'config.toml'), 'authored = true\n');
      const installed = call('skills', 'install', '--json');

      assert.equal(installed.status, 0, installed.stderr);

      const result = skillsInstallResultSchema.parse(JSON.parse(installed.stdout));

      assert.equal(result.outcome, 'installed');

      const available = skillsInspectResultSchema.parse(
        JSON.parse(call('skills', 'inspect', '--role', 'orchestrator', '--json').stdout),
      );

      assert.ok(available.outcome === 'completed' && available.value.available);
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'authored = true\n');

      await assert.rejects(access(join(temporary, 'AGENTS.md')), { code: 'ENOENT' });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

await test('a changed asset under an already installed version is not silently republished', async () => {
  await fixture(async (root, deps, original) => {
    installed(await installSkills({ schemaVersion: 1, root }, deps));
    const changed = structuredClone(original);
    changed.contents[0]!.content += '\nChanged fixture guidance without a version bump.\n';
    changed.catalog.skills[0]!.sha256 = hash(changed.contents[0]!.content);
    const result = await installSkills(
      { schemaVersion: 1, root },
      { ...deps, bundle: { read: async () => completed(changed) } },
    );

    assert.ok(result.outcome === 'blocked');
    assert.equal(result.view.skills[0]?.reason, 'asset_version_conflict');
    assert.equal(result.writes.length, 0);
    assert.equal(
      await readFile(join(root, changed.catalog.skills[0]!.path), 'utf8'),
      original.contents[0]!.content,
    );
  });
});
