import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createGhProvider, nodeProcessRunner } from '../src/index.js';
import { marker, publication } from './support/github.js';

for (const failPost of [false, true]) {
  await test(
    `GitHub crosses the real subprocess/private-file boundary and ${failPost ? 'recovers a lost response' : 'confirms publication'}`,
    { timeout: 30000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'astack gh process '));

      try {
        const executable = join(directory, 'fake gh.mjs');
        const record = join(directory, 'remote fixture.json');
        await copyFile(
          fileURLToPath(new URL('./fixtures/github-cli.mjs', import.meta.url)),
          executable,
        );
        await chmod(executable, 0o700);
        await writeFile(record, JSON.stringify({ calls: [], posts: 0, comment: null }), {
          mode: 0o600,
        });
        const provider = createGhProvider({
          executable,
          runner: nodeProcessRunner,
          now: Date.now,
          artifactParent: directory,
          environment: {
            PATH: dirname(process.execPath),
            ASTACK_GH_FIXTURE_RECORD: record,
            ASTACK_GH_FIXTURE_FAIL_POST: failPost ? '1' : '0',
          },
        });
        const p = publication('comment');
        const input = { publication: p, marker, root: directory };
        const result = await provider.publish(input);

        assert.equal(result.outcome, failPost ? 'uncertain' : 'completed', JSON.stringify(result));

        const recovered = await provider.findPublication(input);
        const remote = JSON.parse(await readFile(record, 'utf8')) as {
          posts: number;
          calls: string[][];
          comment: { body: string };
        };

        assert.ok(recovered.outcome === 'completed' && recovered.value);
        assert.equal(remote.posts, 1);
        assert.equal(remote.comment.body, `${p.body}\n\n${marker}`);
        assert.equal(
          remote.calls.filter((args) => args[args.indexOf('--method') + 1] === 'POST').length,
          1,
        );
        assert.ok(remote.calls.every((args) => !args.some((arg) => arg.includes(p.body))));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
