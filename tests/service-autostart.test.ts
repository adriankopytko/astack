import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { openSqliteState } from '../src/adapters/state/open-sqlite-state.js';
import { serviceRunRequestSchema } from '../src/contracts/service.js';
import { readServiceSettings } from '../src/cli/service-settings.js';
import { DatabaseSync } from 'node:sqlite';

const entry = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

await test('service defaults to four workers and rejects invalid settings', async () => {
  const root = await realpath(
    await mkdtemp(join(existsSync('/private/tmp') ? '/private/tmp' : '/tmp', 'as-settings-')),
  );

  try {
    assert.equal(serviceRunRequestSchema.parse({ schemaVersion: 1 }).limits.global, 4);
    assert.equal(serviceRunRequestSchema.parse({ schemaVersion: 1 }).limits.defaultRole, 4);

    await writeFile(join(root, 'service.json'), JSON.stringify({ concurrency: { global: 0 } }));

    assert.equal((await readServiceSettings(root)).outcome, 'rejected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test(
  'concurrent submissions start one background service and do not start agents',
  { timeout: 60000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(existsSync('/private/tmp') ? '/private/tmp' : '/tmp', 'as-')),
    );
    const state = join(root, 'state');
    const codex = join(root, 'codex');
    const processes = () => {
      const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });

      return result.stdout
        .split('\n')
        .filter((line) => line.includes(state) && line.includes('service run'))
        .map((line) => Number(line.trim().split(/\s+/)[0]));
    };

    try {
      await writeFile(codex, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: state });

      assert.equal(opened.outcome, 'opened');

      if (opened.outcome !== 'opened') {
        return;
      }

      opened.store.close();
      const oldState = new DatabaseSync(join(state, 'state.sqlite'));
      oldState.exec(
        'DROP TABLE worker_requests; DELETE FROM state_migrations WHERE version>=21; PRAGMA user_version=20;',
      );
      oldState.close();
      await writeFile(
        join(state, 'service.json'),
        JSON.stringify({ concurrency: { global: 6, perAgent: 3 } }),
      );
      const call = () =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              entry,
              '--state-directory',
              state,
              '--herdr-executable',
              '/usr/bin/false',
              'handoff',
              'submit',
              '--agent',
              'implementer',
              '--project',
              'missing-project',
              '--task',
              'test',
              '--json',
            ],
            {
              env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let output = '';
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, output }));
        });
      const results = await Promise.all([call(), call()]);

      for (const result of results) {
        assert.equal(result.code, 1, result.output);
        assert.doesNotMatch(result.output, /service_unavailable|service_endpoint_unsafe/);
        assert.match(result.output, /project_not_found/);
      }

      const running = processes();

      assert.equal(running.length, 1);

      const status = spawnSync(
        process.execPath,
        [entry, '--state-directory', state, 'service', 'status', '--json'],
        { encoding: 'utf8' },
      );

      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).value.limits.global, 6);
      assert.equal(JSON.parse(status.stdout).value.limits.defaultRole, 3);

      const errors = spawnSync(
        process.execPath,
        [entry, '--state-directory', state, 'errors', 'list', '--json'],
        { encoding: 'utf8' },
      );
      const records = JSON.parse(errors.stdout).value as { id: string; code: string }[];

      assert.equal(errors.status, 0, errors.stderr);
      assert.ok(records.some((record) => record.code === 'project_not_found'));

      const inspected = spawnSync(
        process.execPath,
        [entry, '--state-directory', state, 'errors', 'inspect', records[0]!.id, '--json'],
        { encoding: 'utf8' },
      );

      assert.equal(inspected.status, 0, inspected.stderr);
      assert.equal(JSON.parse(inspected.stdout).value.id, records[0]!.id);

      const subsequent = await call();

      assert.match(subsequent.output, /project_not_found/);
      assert.deepEqual(processes(), running);

      const stop = spawnSync(
        process.execPath,
        [entry, '--state-directory', state, 'service', 'stop', '--json'],
        { encoding: 'utf8' },
      );

      assert.equal(stop.status, 0, stop.stdout + stop.stderr);
      assert.equal(JSON.parse(stop.stdout).value.stopping, true);

      for (let attempt = 0; attempt < 30 && processes().length > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.equal(processes().length, 0);
    } finally {
      for (const pid of processes()) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          continue;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(root, { recursive: true, force: true });
    }
  },
);
