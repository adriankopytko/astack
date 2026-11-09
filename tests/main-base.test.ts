import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainBaseResolver } from '../src/adapters/git/main-base.js';
import { nodeProcessRunner } from '../src/core/node-process-runner.js';
import { git, gitPath } from './support/service.js';

await test(
  'fetches the newest origin/main without switching or modifying the primary checkout',
  { timeout: 60000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astack-main-')));
    const remote = join(root, 'remote.git');
    const source = join(root, 'source');
    const update = join(root, 'update');

    try {
      git(root, 'init', '--bare', '-b', 'main', remote);
      git(root, 'clone', remote, source);
      git(source, 'commit', '--allow-empty', '-m', 'first');
      git(source, 'push', 'origin', 'main');
      git(source, 'checkout', '-b', 'feature');
      const original = git(source, 'rev-parse', 'HEAD');
      await writeFile(join(source, 'uncommitted.txt'), 'preserve');
      git(root, 'clone', remote, update);
      git(update, 'commit', '--allow-empty', '-m', 'second');
      git(update, 'push', 'origin', 'main');
      const expected = git(update, 'rev-parse', 'HEAD');
      const resolver = createMainBaseResolver({
        executable: gitPath,
        runner: nodeProcessRunner,
        environment: process.env,
      });
      const result = await resolver.resolve(source);

      assert.equal(result.outcome, 'completed', JSON.stringify(result));

      if (result.outcome === 'completed') {
        assert.equal(result.value, expected);
      }

      assert.equal(git(source, 'rev-parse', 'HEAD'), original);
      assert.equal(git(source, 'branch', '--show-current'), 'feature');
      assert.equal(git(source, 'status', '--porcelain'), '?? uncommitted.txt');

      git(source, 'remote', 'remove', 'origin');
      const failed = await resolver.resolve(source);

      assert.equal(failed.outcome, 'rejected');
      assert.equal(git(source, 'rev-parse', 'HEAD'), original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
