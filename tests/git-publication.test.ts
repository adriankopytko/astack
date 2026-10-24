import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGitPublisher,
  nodeProcessRunner,
  processRequestSchema,
  type ProcessExecution,
  type ProcessRequest,
} from '../src/index.js';
import { http, timedOut } from './support/github.js';
const sha = 'a'.repeat(40);
const old = 'b'.repeat(40);
const intent = {
  repository: { host: 'github.com', repository: 'example/project' },
  branch: 'task/fixture',
  sha,
  expectedHead: null as string | null,
};
function output(text: string, code = 0): ProcessExecution {
  return {
    ...http(null, 200, {}, code),
    stdout: {
      text,
      capturedBytes: Buffer.byteLength(text),
      observedBytes: Buffer.byteLength(text),
      complete: true,
      truncated: false,
      artifact: null,
    },
  };
}

function fixture(replies: ProcessExecution[]) {
  const calls: ProcessRequest[] = [];
  const publisher = createGitPublisher({
    executable: '/trusted/git',
    githubExecutable: "/trusted/bin/gh 'quoted'",
    environment: {
      HOME: '/private/host',
      PATH: '/trusted/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_SSH_COMMAND: 'untrusted',
      GH_TOKEN: 'fixture-secret',
    },
    now: () => 1000,
    runner: {
      async run(request) {
        processRequestSchema.parse(request);
        calls.push(request);
        const result = replies.shift();

        assert.ok(result, 'Unexpected subprocess');

        return result;
      },
    },
  });

  return { publisher, calls };
}

const matching = () => output(`${sha}\trefs/heads/task/fixture\n`);
const input = { root: '/private/checkout', intent };

await test('Git publication pins destination, exact SHA, empty-ref lease and controlled credentials without changing config', async () => {
  const f = fixture([output('core.repositoryformatversion\0'), output(''), output(''), matching()]);
  const result = await f.publisher.push(input);

  assert.equal(result.outcome, 'completed');

  const push = f.calls.find((call) => call.args.includes('push'));

  assert.ok(push);
  assert.ok(push.args.includes('--force-with-lease=refs/heads/task/fixture:'));
  assert.ok(push.args.includes(`${sha}:refs/heads/task/fixture`));
  assert.ok(push.args.includes('https://github.com/example/project.git'));
  assert.ok(push.args.includes('--no-verify'));
  assert.ok(push.args.includes('--no-follow-tags'));
  assert.ok(push.args.includes('--recurse-submodules=no'));
  assert.equal(push.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(push.env.GIT_SSH_COMMAND, undefined);
  assert.equal(push.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(push.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(push.env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(push.env.GIT_GRAFT_FILE, '/dev/null');
  assert.equal(
    push.args.some((arg) => arg.includes('fixture-secret')),
    false,
  );
  assert.ok(
    push.args.some((arg) => arg.startsWith('credential.helper=!') && arg.includes("'\\''")),
  );
  assert.equal(
    f.calls.some((call) => call.args.includes('--global')),
    false,
  );
});

await test('an already matching remote ref is observed without pushing', async () => {
  const f = fixture([output(''), matching(), matching()]);

  assert.equal((await f.publisher.push(input)).outcome, 'completed');
  assert.equal(
    f.calls.some((call) => call.args.includes('push')),
    false,
  );
});

await test('existing remote refs require local fast-forward evidence and their explicit expected-head lease', async () => {
  const f = fixture([
    output(''),
    output(`${old}\trefs/heads/task/fixture\n`),
    output(''),
    output(''),
    matching(),
  ]);
  const result = await f.publisher.push({ ...input, intent: { ...intent, expectedHead: old } });

  assert.equal(result.outcome, 'completed');
  assert.ok(
    f.calls.some(
      (call) =>
        call.args.includes('--is-ancestor') && call.args.slice(-2).join(',') === `${old},${sha}`,
    ),
  );
  assert.ok(
    f.calls.some((call) => call.args.includes(`--force-with-lease=refs/heads/task/fixture:${old}`)),
  );
});

for (const problem of ['unexpected-head', 'non-fast-forward'] as const) {
  await test(`Git publication rejects ${problem} before pushing`, async () => {
    const f = fixture([output(''), output(`${old}\trefs/heads/task/fixture\n`), output('', 1)]);
    const result = await f.publisher.push({
      ...input,
      intent: { ...intent, expectedHead: problem === 'non-fast-forward' ? old : null },
    });

    assert.equal(result.outcome, 'rejected');
    assert.equal(
      f.calls.some((call) => call.args.includes('push')),
      false,
    );
  });
}

for (const config of [
  'include.path',
  'includeif.gitdir:x.path',
  'url.https://evil/.insteadof',
  'credential.helper',
  'http.proxy',
  'push.pushoption',
  'sendpack.sideband',
  'core.sshcommand',
]) {
  await test(`Git publication refuses local ${config} configuration before network calls`, async () => {
    const f = fixture([output(`${config}\0`)]);

    assert.equal((await f.publisher.push(input)).outcome, 'rejected');
    assert.equal(f.calls.length, 1);
  });
}

for (const problem of [
  'wrong-sha',
  'wrong-ref',
  'duplicate-ref',
  'truncated',
  'live-group',
  'timeout',
] as const) {
  await test(`Git inspection rejects ${problem} remote evidence`, async () => {
    const reply =
      problem === 'wrong-sha'
        ? output(`${old}\trefs/heads/task/fixture\n`)
        : problem === 'wrong-ref'
          ? output(`${sha}\trefs/heads/other\n`)
          : problem === 'duplicate-ref'
            ? output(`${sha}\trefs/heads/task/fixture\n${sha}\trefs/heads/task/fixture\n`)
            : problem === 'truncated'
              ? { ...matching(), stdout: { ...matching().stdout, truncated: true } }
              : problem === 'live-group'
                ? {
                    ...matching(),
                    shutdown: {
                      root: 'exited' as const,
                      processGroup: 'present' as const,
                      termSent: false,
                      killSent: false,
                    },
                  }
                : timedOut();
    const f = fixture([output(''), reply]);

    assert.equal((await f.publisher.inspect(input)).outcome, 'rejected');
  });
}

await test('a failed response after entering push remains uncertain, even if the ref may have been accepted', async () => {
  const f = fixture([output(''), output(''), timedOut()]);
  const result = await f.publisher.push(input);

  assert.equal(result.outcome, 'uncertain');
  assert.equal(f.calls.filter((call) => call.args.includes('push')).length, 1);
});

await test(
  'real subprocesses with spaced paths recover a lost push response through observation without another write',
  { timeout: 30000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'astack fake git ')));

    try {
      const executable = join(directory, 'fake git.mjs');
      const state = join(directory, 'remote.json');
      await writeFile(state, JSON.stringify({ pushes: 0, sha: null }));
      await writeFile(
        executable,
        `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst path = ${JSON.stringify(state)};\nconst state = JSON.parse(readFileSync(path, 'utf8'));\nconst args = process.argv.slice(2);\nif (args.includes('config')) process.exit(0);\nif (args.includes('push')) { state.pushes++; state.sha = ${JSON.stringify(sha)}; writeFileSync(path, JSON.stringify(state)); process.exit(1); }\nif (args.includes('ls-remote')) { if (state.sha) process.stdout.write(state.sha + '\\trefs/heads/task/fixture\\n'); process.exit(0); }\nprocess.exit(2);\n`,
      );
      await chmod(executable, 0o700);
      const options = {
        executable,
        githubExecutable: join(directory, 'unused gh'),
        runner: nodeProcessRunner,
        environment: { PATH: '/usr/bin:/bin' },
        now: () => 1000,
      };
      const first = await createGitPublisher(options).push({ root: directory, intent });

      assert.equal(first.outcome, 'uncertain');

      const observed = await createGitPublisher(options).inspect({ root: directory, intent });

      assert.ok(observed.outcome === 'completed' && observed.value?.sha === sha);

      const recorded: unknown = JSON.parse(await readFile(state, 'utf8'));

      assert.deepEqual(recorded, { pushes: 1, sha });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
