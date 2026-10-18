import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { herdrPromptArgs } from '../src/adapters/herdr/prompt-args.js';

const [executable, ...extra] = process.argv.slice(2);

assert.ok(
  executable && isAbsolute(executable) && extra.length === 0,
  'Usage: pnpm check:herdr-cli /absolute/path/to/herdr',
);

const parent = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
const root = await realpath(await mkdtemp(join(parent, 'as-herdr-')));

try {
  for (const text of [
    '# Assignment\nSecond line; $(literal)',
    '--not-an-option',
    '--',
    'literal text',
  ]) {
    const result: SpawnSyncReturns<string> = spawnSync(
      executable,
      herdrPromptArgs('astack-cli-probe', text),
      {
        cwd: root,
        env: {
          HERDR_SOCKET_PATH: join(root, 'missing.sock'),
          HERDR_SESSION: 'default',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 32768,
      },
    );

    assert.equal(result.error, undefined, 'Herdr CLI probe failed to execute');
    assert.equal(result.status, 1, 'Herdr CLI must parse argv and reject the nonexistent server');
    assert.equal(result.stdout, '', 'Unexpected stdout from offline CLI probe');

    let response: unknown;

    try {
      response = JSON.parse(String(result.stderr));
    } catch {
      assert.fail('Herdr CLI rejected prompt syntax or returned unsupported diagnostics');
    }

    assert.ok(
      z.object({ error: z.object({ code: z.literal('server_not_running') }) }).safeParse(response)
        .success,
      'Probe must not contact any running server',
    );
  }

  process.stdout.write(
    'Herdr prompt argv compatibility passed (4 offline probes; no server or agent contacted).\n',
  );
} finally {
  await rmdir(root);
}
