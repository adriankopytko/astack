import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createGitInspector,
  inspectGitRepository,
  gitInspectionResultSchema,
  gitRepositoryInspectionSchema,
  nodeProcessRunner,
  type GitRepositoryInspection,
  type GitInspectionResult,
  type ProcessRunner,
  type ProcessExecution,
  type ProcessRequest,
} from '../src/index.js';
import { parseGitRemotes, parseGitStatus, parseGitWorktrees } from '../src/core/git-output.js';

const foundGit = spawnSync('/usr/bin/which', ['git'], {
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
});

assert.equal(foundGit.status, 0);

const executable = foundGit.stdout.trim();
const options = { timeout: 30_000 };
const inspector = createGitInspector({ executable, runner: nodeProcessRunner, timeoutMs: 20_000 });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(executable, ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    },
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.replace(/\n$/, '');
}

async function temporary(check: (directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'astack git ')));

  try {
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function repository(directory: string, objectFormat = 'sha1'): Promise<string> {
  const root = join(directory, 'repository with spaces');
  await mkdir(root);
  git(root, 'init', '--initial-branch=main', `--object-format=${objectFormat}`);
  await writeFile(join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'fixture');

  return root;
}

async function inspect(path: string, baseRef?: string): Promise<GitRepositoryInspection> {
  const result = gitInspectionResultSchema.parse(
    await inspectGitRepository({ schemaVersion: 1, path, baseRef }, inspector),
  );

  if (result.outcome !== 'completed') {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

function errorCode(result: GitInspectionResult): string {
  assert.equal(result.outcome, 'rejected');

  if (result.outcome === 'rejected') {
    return result.error.code;
  }

  return assert.fail('Expected rejection');
}

await test(
  'Git request validation rejects invalid selectors without accessing the reader',
  options,
  async () => {
    let calls = 0;
    const reader = {
      inspect: () => {
        calls++;

        throw new Error('Must not inspect');
      },
    };

    for (const input of [
      { schemaVersion: 1, path: 'relative' },
      { schemaVersion: 1, path: '/work\0secret' },
      ...[
        '--all',
        'main~1',
        'main^{commit}',
        'main:secret',
        'a..b',
        'a//b',
        'a.lock',
        '@',
        'a\nb',
        'a b',
      ].map((baseRef) => ({ schemaVersion: 1, path: '/work', baseRef })),
      { schemaVersion: 1, path: '/work', force: true },
    ]) {
      assert.equal(errorCode(await inspectGitRepository(input, reader)), 'invalid_request');
    }

    assert.equal(
      errorCode(await inspectGitRepository({ schemaVersion: 2, path: '/work' }, reader)),
      'unsupported_contract_version',
    );

    const controller = new AbortController();
    controller.abort();

    assert.equal(
      errorCode(
        await inspectGitRepository({ schemaVersion: 1, path: '/work' }, reader, controller.signal),
      ),
      'cancelled',
    );
    assert.equal(calls, 0);
    assert.equal(
      errorCode(
        await inspectGitRepository(
          { schemaVersion: 1, path: '/work' },
          {
            inspect: () => {
              throw new Error('private-secret');
            },
          },
        ),
      ),
      'git_failed',
    );
  },
);

await test(
  'normal, nested, and aliased paths share canonical identity without touching the index',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      const nested = join(root, 'nested');
      await mkdir(nested);
      const alias = join(directory, 'alias');
      await symlink(root, alias);
      const before = await stat(join(root, '.git/index'), { bigint: true });
      const bytes = await readFile(join(root, '.git/index'));
      const first = await inspect(root, 'main');
      const second = await inspect(nested, 'refs/heads/main');
      const third = await inspect(alias, 'HEAD');
      const after = await stat(join(root, '.git/index'), { bigint: true });

      assert.equal(first.repository.commonDirectory, join(root, '.git'));
      assert.equal(first.checkout.rootPath, root);
      assert.equal(first.checkout.gitDirectory, join(root, '.git'));
      assert.equal(first.checkout.head.branch, 'refs/heads/main');
      assert.equal(first.base?.commit, git(root, 'rev-parse', 'HEAD'));
      assert.equal(first.base?.fullRef, 'refs/heads/main');
      assert.equal(first.status.clean, true);
      assert.deepEqual(second.repository, first.repository);
      assert.deepEqual(third.checkout, first.checkout);
      assert.equal(third.base?.commit, first.base?.commit);
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.deepEqual(await readFile(join(root, '.git/index')), bytes);
    });
  },
);

await test(
  'linked worktrees share common-directory identity; independent clones do not',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      const linked = join(directory, 'worker checkout');
      const clone = join(directory, 'independent clone');
      git(root, 'worktree', 'add', '-b', 'worker', linked);
      git(root, 'worktree', 'lock', '--reason', 'not public\nreason', linked);
      git(directory, 'clone', '--no-hardlinks', root, clone);
      const primary = await inspect(root);
      const worker = await inspect(linked);
      const independent = await inspect(clone);

      assert.equal(worker.repository.commonDirectory, primary.repository.commonDirectory);
      assert.notEqual(worker.checkout.gitDirectory, primary.checkout.gitDirectory);
      assert.equal(worker.checkout.rootPath, linked);
      assert.equal(worker.checkout.head.branch, 'refs/heads/worker');
      assert.notEqual(independent.repository.commonDirectory, primary.repository.commonDirectory);
      assert.equal(primary.worktrees.length, 2);
      assert.equal(primary.worktrees.find((tree) => tree.path === linked)?.locked, true);
      assert.doesNotMatch(JSON.stringify(primary), /not public/);
    });
  },
);

await test(
  'status retains staged, unstaged, renamed and untracked paths with unusual characters',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      await writeFile(join(root, 'staged.txt'), 'staged\n');
      git(root, 'add', 'staged.txt');
      await writeFile(join(root, 'staged.txt'), 'unstaged after staging\n');
      await rename(join(root, 'tracked.txt'), join(root, 'renamed\nfile.txt'));
      git(root, 'add', '-A');
      await writeFile(join(root, 'staged.txt'), 'changed again\n');
      await writeFile(join(root, 'untracked\tfile.txt'), 'private contents');
      await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
      await writeFile(join(root, 'ignored.txt'), 'ignored');
      const result = await inspect(root);
      const staged = result.status.entries.find((entry) => entry.path === 'staged.txt');
      const renamed = result.status.entries.find((entry) => entry.path === 'renamed\nfile.txt');

      assert.equal(result.status.clean, false);
      assert.equal(staged?.indexStatus, 'A');
      assert.equal(staged?.worktreeStatus, 'M');
      assert.equal(renamed?.kind, 'renamed');
      assert.equal(renamed?.originalPath, 'tracked.txt');
      assert.equal(
        result.status.entries.find((entry) => entry.path === 'untracked\tfile.txt')?.kind,
        'untracked',
      );
      assert.equal(
        result.status.entries.some((entry) => entry.path === 'ignored.txt'),
        false,
      );
      assert.doesNotMatch(JSON.stringify(result), /private contents/);
    });
  },
);

await test(
  'refs resolve full commits and annotated tags; ambiguity and non-commit targets reject',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      git(root, 'tag', '-a', 'release', '-m', 'tag');
      git(root, 'tag', 'main');
      const sha = git(root, 'rev-parse', 'HEAD');
      const tree = git(root, 'rev-parse', 'HEAD^{tree}');
      git(root, 'tag', 'tree-target', tree);

      assert.equal((await inspect(root, 'release')).base?.commit, sha);
      assert.equal((await inspect(root, 'refs/heads/main')).base?.commit, sha);
      assert.equal((await inspect(root, sha)).base?.commit, sha);

      for (const [baseRef, code] of [
        ['main', 'base_ref_ambiguous'],
        ['missing', 'base_ref_not_found'],
        ['f'.repeat(40), 'base_ref_not_found'],
        ['tree-target', 'base_ref_not_commit'],
      ]) {
        assert.equal(
          errorCode(
            await inspectGitRepository({ schemaVersion: 1, path: root, baseRef }, inspector),
          ),
          code,
        );
      }

      git(root, 'checkout', '--detach', sha);
      const detached = await inspect(root, 'HEAD');

      assert.deepEqual(detached.checkout.head, { branch: null, commit: sha });
      assert.equal(detached.worktrees[0]?.detached, true);
    });
  },
);

await test(
  'unborn branches and SHA-256 repositories retain explicit head and object format',
  options,
  async () => {
    await temporary(async (directory) => {
      git(directory, 'init', '--initial-branch=main');
      const unborn = await inspect(directory);

      assert.deepEqual(unborn.checkout.head, { branch: 'refs/heads/main', commit: null });
      assert.equal(unborn.status.clean, true);
      assert.equal(unborn.worktrees[0]?.head, null);
      assert.equal(
        errorCode(
          await inspectGitRepository(
            { schemaVersion: 1, path: directory, baseRef: 'HEAD' },
            inspector,
          ),
        ),
        'base_ref_not_found',
      );

      const root = await repository(directory, 'sha256');
      const sha256 = await inspect(root, 'HEAD');

      assert.equal(sha256.repository.objectFormat, 'sha256');
      assert.equal(sha256.base?.commit.length, 64);
      assert.equal(
        gitRepositoryInspectionSchema.safeParse({
          ...sha256,
          repository: { ...sha256.repository, objectFormat: 'sha1' },
        }).success,
        false,
      );
    });
  },
);

await test(
  'remote facts never expose credentials, URL paths, query strings, fragments or helper commands',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      git(
        root,
        'config',
        '--add',
        'remote.origin.url',
        'https://secret-user:secret-password@example.invalid/private-path?token=secret-query#secret-fragment',
      );
      git(
        root,
        'config',
        '--add',
        'remote.origin.pushurl',
        'ssh://secret-user@example.invalid:2222/private-path',
      );
      git(root, 'config', '--add', 'remote.backup.url', 'secret-user@example.invalid:private-path');
      git(root, 'config', '--add', 'remote.local.url', '/private-path/secret-local');
      git(root, 'config', '--add', 'remote.helper.url', 'ext::sh -c secret-command');
      const result = await inspect(root);
      const origin = result.remotes.find((remote) => remote.name === 'origin');

      assert.deepEqual(origin?.fetch, [
        { transport: 'https', host: 'example.invalid', port: null },
      ]);
      assert.deepEqual(origin?.push, [{ transport: 'ssh', host: 'example.invalid', port: 2222 }]);
      assert.deepEqual(result.remotes.find((remote) => remote.name === 'backup')?.fetch, [
        { transport: 'ssh', host: 'example.invalid', port: null },
      ]);
      assert.doesNotMatch(JSON.stringify(result), /secret-|private-path/);
    });
  },
);

await test(
  'missing paths, non-repositories, bare repositories and missing executables reject safely',
  options,
  async () => {
    await temporary(async (directory) => {
      assert.equal(
        errorCode(
          await inspectGitRepository(
            { schemaVersion: 1, path: join(directory, 'missing') },
            inspector,
          ),
        ),
        'path_unavailable',
      );
      assert.equal(
        errorCode(await inspectGitRepository({ schemaVersion: 1, path: directory }, inspector)),
        'not_git_repository',
      );

      const bare = join(directory, 'bare');
      git(directory, 'init', '--bare', bare);

      assert.equal(
        errorCode(await inspectGitRepository({ schemaVersion: 1, path: bare }, inspector)),
        'unsupported_repository',
      );

      const unavailable = createGitInspector({
        executable: join(directory, 'missing-git'),
        runner: nodeProcessRunner,
      });
      const result = await inspectGitRepository({ schemaVersion: 1, path: directory }, unavailable);

      assert.equal(errorCode(result), 'git_unavailable');
      assert.doesNotMatch(JSON.stringify(result), /missing-git/);
    });
  },
);

await test(
  'controlled environment ignores ambient Git targeting and disables fsmonitor hooks',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      const marker = join(directory, 'must not run');
      const hook = join(directory, 'fsmonitor');
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
      git(root, 'config', 'core.fsmonitor', hook);
      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = '/not-the-target';

      try {
        const value = await inspect(root);

        assert.equal(value.checkout.rootPath, root);

        await assert.rejects(stat(marker), { code: 'ENOENT' });
      } finally {
        if (previous === undefined) {
          delete process.env.GIT_DIR;
        } else {
          process.env.GIT_DIR = previous;
        }
      }
    });
  },
);

function wrappedRunner(
  change: (result: ProcessExecution, request: ProcessRequest) => ProcessExecution,
): ProcessRunner {
  return {
    async run(request, signal) {
      const result = await nodeProcessRunner.run(request, signal);

      return result.outcome === 'rejected' ? result : change(result, request);
    },
  };
}

await test(
  'truncated, incomplete, malformed and lossy output never become complete Git facts',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);

      for (const change of [
        (result: ProcessExecution) => ({
          ...result,
          stdout: { ...result.stdout, complete: false },
        }),
        (result: ProcessExecution) => ({
          ...result,
          stdout: {
            ...result.stdout,
            text: '',
            capturedBytes: 0,
            truncated: result.stdout.observedBytes > 0,
          },
        }),
        (result: ProcessExecution) => ({
          ...result,
          stdout: { ...result.stdout, text: 'bad\uFFFD' },
        }),
      ]) {
        const selected = createGitInspector({ executable, runner: wrappedRunner(change) });
        const result = await inspectGitRepository({ schemaVersion: 1, path: root }, selected);

        assert.ok(['git_output_incomplete', 'invalid_git_output'].includes(errorCode(result)));
      }

      const capped = createGitInspector({
        executable,
        runner: nodeProcessRunner,
        maxCaptureBytes: 1,
      });

      assert.equal(
        errorCode(await inspectGitRepository({ schemaVersion: 1, path: root }, capped)),
        'git_output_incomplete',
      );
    });
  },
);

await test(
  'detected changes between observations reject; no automatic retry is attempted',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      let statuses = 0;
      const runner: ProcessRunner = {
        async run(request, signal) {
          const result = await nodeProcessRunner.run(request, signal);

          if (request.args.includes('status')) {
            statuses++;

            if (statuses === 1) {
              await writeFile(join(root, 'tracked.txt'), 'concurrent change\n');
            }
          }

          return result;
        },
      };
      const selected = createGitInspector({ executable, runner });
      const result = await inspectGitRepository({ schemaVersion: 1, path: root }, selected);

      assert.equal(errorCode(result), 'repository_changed');
      assert.equal(statuses, 2);
      assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'concurrent change\n');
    });
  },
);

await test(
  'timeout, cancellation and thrown runner errors return fixed errors without diagnostics',
  options,
  async () => {
    await temporary(async (directory) => {
      const controller = new AbortController();
      const cancelRunner: ProcessRunner = {
        run: () => {
          controller.abort();

          throw new Error('private-token');
        },
      };
      const result = await inspectGitRepository(
        { schemaVersion: 1, path: directory },
        createGitInspector({ executable, runner: cancelRunner }),
        controller.signal,
      );

      assert.equal(errorCode(result), 'cancelled');
      assert.doesNotMatch(JSON.stringify(result), /private-token/);

      const timed = createGitInspector({
        executable,
        runner: wrappedRunner((value) => ({ ...value, outcome: 'timed_out' })),
      });

      assert.equal(
        errorCode(await inspectGitRepository({ schemaVersion: 1, path: directory }, timed)),
        'git_timed_out',
      );

      let calls = 0;
      const unused: ProcessRunner = {
        run: () => {
          calls++;

          throw new Error('must not run');
        },
      };

      for (const config of [
        { executable: 'git' },
        { executable, timeoutMs: 0 },
        { executable, maxCaptureBytes: -1 },
      ]) {
        assert.equal(
          errorCode(
            await inspectGitRepository(
              { schemaVersion: 1, path: directory },
              createGitInspector({ ...config, runner: unused }),
            ),
          ),
          'invalid_request',
        );
      }

      assert.equal(calls, 0);
    });
  },
);

await test(
  'machine parsers preserve rename ordering, conflicts, submodules and opaque nested repositories',
  options,
  () => {
    const sha = 'a'.repeat(40);
    const header = `# branch.oid ${sha}\0# branch.head main\0`;
    const status = parseGitStatus(
      header +
        `u UU N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} conflict\0` +
        `1 .M S.MU 160000 160000 160000 ${sha} ${sha} module\0` +
        `2 R. N... 100644 100644 100644 ${sha} ${sha} R100 renamed file\0old file\0? nested/\0`,
    );

    assert.equal(status.entries[0]?.kind, 'unmerged');
    assert.equal(status.entries[1]?.submodule, 'S.MU');
    assert.equal(status.entries[2]?.originalPath, 'old file');
    assert.equal(status.entries[3]?.path, 'nested/');
    assert.throws(() => parseGitStatus(header + '? unterminated'));
    assert.throws(() => parseGitStatus(header + '2 broken\0'));
    assert.throws(() => parseGitWorktrees(`worktree /work\0HEAD ${sha}\0`));
    assert.deepEqual(parseGitRemotes('remote.v6.url\nssh://user@[::1]:2222/private\0')[0]?.fetch, [
      { transport: 'ssh', host: '[::1]', port: 2222 },
    ]);
  },
);

await test(
  'real conflicts, nested repositories, deleted files and stale worktrees stay visible',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      git(root, 'checkout', '-b', 'other');
      await writeFile(join(root, 'tracked.txt'), 'other\n');
      git(root, 'commit', '-am', 'other');
      git(root, 'checkout', 'main');
      await writeFile(join(root, 'tracked.txt'), 'main\n');
      git(root, 'commit', '-am', 'main');
      const merge = spawnSync(
        executable,
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'merge',
          'other',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 5000,
          env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        },
      );

      assert.equal(merge.status, 1);

      const nested = join(root, 'nested-repository');
      await mkdir(nested);
      git(nested, 'init', '--initial-branch=main');
      await writeFile(join(nested, 'untracked'), 'inside nested');
      const stale = join(directory, 'stale-worker');
      git(root, 'worktree', 'add', '-b', 'stale-worker', stale, 'HEAD');
      await rm(stale, { recursive: true });
      const result = await inspect(root);

      assert.equal(
        result.status.entries.find((entry) => entry.path === 'tracked.txt')?.kind,
        'unmerged',
      );
      assert.equal(
        result.status.entries.find((entry) => entry.path === 'nested-repository/')?.kind,
        'untracked',
      );
      assert.equal(result.worktrees.find((tree) => tree.path === stale)?.prunable, true);
      assert.equal(result.worktrees.length, 2);
    });
  },
);

await test(
  'repository roots containing newlines remain canonical and literal',
  options,
  async () => {
    await temporary(async (directory) => {
      const initial = await repository(directory);
      const root = join(directory, 'root\nwith newline');
      await rename(initial, root);
      const result = await inspect(root);

      assert.equal(result.checkout.rootPath, root);
      assert.equal(result.worktrees[0]?.path, root);
      assert.equal(result.repository.commonDirectory, join(root, '.git'));
    });
  },
);

await test(
  'runner receives explicit arguments, a shrinking total budget and no output artifacts',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      let previousBudget = 20_001;
      let calls = 0;
      const runner: ProcessRunner = {
        async run(request, signal) {
          calls++;

          assert.equal(request.executable, executable);
          assert.equal(request.cwd, root);
          assert.ok(request.timeoutMs <= previousBudget);
          assert.ok(request.timeoutMs > 0);
          assert.equal(request.artifacts, undefined);
          assert.equal(request.env.GIT_DIR, undefined);
          assert.equal(request.env.GIT_ALLOW_PROTOCOL, '');
          assert.equal(request.env.GIT_CONFIG_GLOBAL, '/dev/null');
          assert.ok(request.args.includes('--no-lazy-fetch'));
          assert.ok(request.args.includes('--no-optional-locks'));

          previousBudget = request.timeoutMs;

          return nodeProcessRunner.run(request, signal);
        },
      };
      const result = await inspectGitRepository(
        { schemaVersion: 1, path: root, baseRef: 'HEAD' },
        createGitInspector({ executable, runner, timeoutMs: 20_000 }),
      );

      assert.equal(result.outcome, 'completed');
      assert.ok(calls > 1);
    });
  },
);

await test(
  'missing promisor objects do not invoke configured remote helpers',
  options,
  async () => {
    await temporary(async (directory) => {
      const root = await repository(directory);
      const marker = join(directory, 'remote-helper-must-not-run');
      git(root, 'config', 'remote.origin.promisor', 'true');
      git(root, 'config', 'remote.origin.url', `ext::sh -c touch ${marker}`);
      git(root, 'config', 'protocol.ext.allow', 'always');
      const result = await inspectGitRepository(
        { schemaVersion: 1, path: root, baseRef: 'f'.repeat(40) },
        inspector,
      );

      assert.equal(errorCode(result), 'base_ref_not_found');

      await assert.rejects(stat(marker), { code: 'ENOENT' });
    });
  },
);
