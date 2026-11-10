import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applicationInfoResultSchema } from '../src/contracts/application-info.js';
import * as astack from '../src/index.js';

const entrypoint = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

await test('legacy explicit hook and verification operations are not public exports', () => {
  assert.equal('executeHook' in astack, false);
  assert.equal('reconcileHook' in astack, false);
  assert.equal('verifyImplementation' in astack, false);
});

await test('compiled CLI works outside its source checkout and keeps JSON output clean', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'astack-cli-'));

  try {
    const result = spawnSync(process.execPath, [entrypoint, 'info', '--json'], {
      cwd,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');

    const envelope = applicationInfoResultSchema.parse(JSON.parse(result.stdout) as unknown);

    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.outcome, 'completed');

    if (envelope.outcome !== 'completed') {
      assert.fail('Expected completed package information');
    }

    const info = envelope.value;

    assert.equal(info.name, 'astack');
    assert.match(info.version, /^\d+\.\d+\.\d+$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

await test('human-readable package information remains concise', () => {
  const result = spawnSync(process.execPath, [entrypoint, 'info'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^astack \d+\.\d+\.\d+ \(foundation\)\n$/);
});

await test('configuration schema is accessible from any directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'astack-schema-'));

  try {
    const result = spawnSync(process.execPath, [entrypoint, 'config-schema'], {
      cwd,
      encoding: 'utf8',
    });
    const schema = JSON.parse(result.stdout) as {
      properties: { agents: { additionalProperties: { properties: { permissions: unknown } } } };
    };

    assert.equal(result.status, 0, result.stderr);
    assert.ok(schema.properties.agents.additionalProperties.properties.permissions);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

await test('unknown commands fail instead of silently accepting work', () => {
  for (const args of [
    ['unavailable-command'],
    ['implement'],
    ['review'],
    ['ci'],
    ['hooks', 'execute'],
    ['verification', 'run'],
  ]) {
    const result = spawnSync(process.execPath, [entrypoint, ...args], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /error:/);
    assert.ok(result.stderr.includes(args[0] ?? ''));
  }

  const incomplete = spawnSync(process.execPath, [entrypoint, 'handoff', 'submit'], {
    encoding: 'utf8',
  });

  assert.notEqual(incomplete.status, 0);
  assert.equal(incomplete.stdout, '');
  assert.match(incomplete.stderr, /required option/);
});

await test('skill output matches the bundled guide from outside the checkout', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'astack-skill-'));

  try {
    const expected = await readFile(
      new URL('../skills/astack-cli/SKILL.md', import.meta.url),
      'utf8',
    );
    const result = spawnSync(process.execPath, [entrypoint, '--skill'], { cwd, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

await test('skill output cannot be combined with a subcommand', () => {
  for (const args of [
    ['--skill', 'info'],
    ['info', '--skill'],
  ]) {
    const result = spawnSync(process.execPath, [entrypoint, ...args], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--skill must be used without a subcommand/);
  }
});
