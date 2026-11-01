import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

await test('default host state uses ~/.astack without moving or deleting legacy state', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'astack-home-')));

  try {
    const legacy = join(home, '.local', 'state', 'astack');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'sentinel'), 'legacy state');
    const source = new URL('../src/adapters/state/state-directory.ts', import.meta.url).href;
    const script = `import {prepareStateDirectory} from ${JSON.stringify(source)}; const result = await prepareStateDirectory(); console.log(result.root.path);`;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(home, '.astack'));
    assert.equal(await readFile(join(legacy, 'sentinel'), 'utf8'), 'legacy state');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
