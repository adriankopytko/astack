import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  createNodeManagedFileStore,
  inspectManagedFile,
  managedFileInspectionSchema,
  managedFileResultSchema,
  nodeManagedFileStore,
  writeManagedFile,
  type ManagedFileResult,
} from '../src/index.js';
import { metadataPaths } from '../src/core/managed-file-metadata.js';
import {
  createPrivateArtifactDirectory,
  openPrivateArtifact,
} from '../src/core/private-artifacts.js';

function input(root: string, content = 'generated content\n', assetVersion = '1') {
  return {
    schemaVersion: 1,
    root,
    path: 'config.json',
    owner: 'astack:test',
    assetVersion,
    content,
  };
}

async function temporary(check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'astack files '));

  try {
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(request: unknown, store = nodeManagedFileStore, signal?: AbortSignal) {
  return managedFileResultSchema.parse(await writeManagedFile(request, store, signal));
}

async function inspect(root: string) {
  return managedFileInspectionSchema.parse(
    await inspectManagedFile({ schemaVersion: 1, root, path: 'config.json' }, nodeManagedFileStore),
  );
}

function blocked(result: ManagedFileResult, reason: string) {
  assert.equal(result.outcome, 'blocked');

  if (result.outcome === 'blocked') {
    assert.equal(result.reason, reason);
  }
}

await test('managed request validation rejects escapes and protected paths before effects', async () => {
  let calls = 0;
  const store = {
    write: () => {
      calls++;

      throw new Error('Unexpected write');
    },
    inspect: () => {
      calls++;

      throw new Error('Unexpected read');
    },
  };

  for (const path of [
    '../outside',
    '/absolute',
    'a/../b',
    'a//b',
    './a',
    'a\\b',
    'bad\0path',
    '.astack-managed/root.json',
    '.astack-stage-example/content',
  ]) {
    const result = await writeManagedFile({ ...input('/work'), path }, store);

    assert.equal(result.outcome, 'rejected');
  }

  for (const request of [
    { ...input('relative') },
    { ...input('/work'), schemaVersion: 2 },
    { ...input('/work'), content: 'x'.repeat(1024 * 1024 + 1) },
    { ...input('/work'), force: true },
  ]) {
    const result = await writeManagedFile(request, store);

    assert.equal(result.outcome, 'rejected');
  }

  const read = await inspectManagedFile(
    { schemaVersion: 2, root: '/work', path: 'config.json' },
    store,
  );

  assert.equal(read.outcome, 'rejected');
  assert.equal(calls, 0);
});

await test('read-only inspection leaves an uninitialized root untouched', async () => {
  await temporary(async (root) => {
    const result = await inspect(root);

    assert.equal(result.outcome, 'inspected');

    if (result.outcome === 'inspected') {
      assert.equal(result.state, 'missing');
      assert.equal(result.record, null);
    }

    assert.deepEqual(await readdir(root), []);
  });
});

await test('create, repeat, and upgrade persist ownership across store instances', async () => {
  await temporary(async (root) => {
    const request = input(root);
    const created = await write(request);
    const before = await stat(join(root, request.path));
    const repeated = await write(request, createNodeManagedFileStore());
    const after = await stat(join(root, request.path));

    assert.equal(created.outcome, 'written');
    assert.equal(repeated.outcome, 'unchanged');
    assert.equal(before.ino, after.ino);
    assert.equal(after.mode & 0o777, 0o600);

    const upgraded = await write(input(root, 'upgraded\n', '2'));
    const inspection = await inspect(root);

    assert.equal(upgraded.outcome, 'written');
    assert.equal(await readFile(join(root, request.path), 'utf8'), 'upgraded\n');
    assert.equal(inspection.outcome, 'inspected');

    if (inspection.outcome === 'inspected') {
      assert.equal(inspection.state, 'managed');
      assert.equal(inspection.record?.assetVersion, '2');
      assert.equal(inspection.record?.owner, request.owner);
      assert.equal(inspection.pending, null);
    }

    const record = await readFile(join(root, metadataPaths(request.path).record), 'utf8');

    assert.doesNotMatch(record, /upgraded/);
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('.astack-stage-')));
  });
});

await test('unowned files are never adopted even when their bytes match', async () => {
  await temporary(async (root) => {
    const request = input(root);
    await writeFile(join(root, request.path), request.content);
    const result = await write(request);

    blocked(result, 'unowned_file');

    assert.equal(await readFile(join(root, request.path), 'utf8'), request.content);
    assert.deepEqual(await readdir(root), [request.path]);
  });
});

await test('edited, permission-changed, and deleted generated files stay untouched', async () => {
  for (const change of ['content', 'mode', 'delete']) {
    await temporary(async (root) => {
      const request = input(root);
      await write(request);

      if (change === 'content') {
        await writeFile(join(root, request.path), 'private-user-value');
      } else if (change === 'mode') {
        await chmod(join(root, request.path), 0o644);
      } else {
        await unlink(join(root, request.path));
      }

      const result = await write(input(root, 'replacement', '2'));

      blocked(result, 'modified_file');

      assert.doesNotMatch(JSON.stringify(result), /private-user-value|replacement/);

      if (change === 'content') {
        assert.equal(await readFile(join(root, request.path), 'utf8'), 'private-user-value');
      }

      if (change === 'delete') {
        await assert.rejects(stat(join(root, request.path)), { code: 'ENOENT' });
      }
    });
  }
});

await test('another owner cannot upgrade a managed file', async () => {
  await temporary(async (root) => {
    await write(input(root));
    const result = await write({ ...input(root, 'changed', '2'), owner: 'another:owner' });

    blocked(result, 'owner_mismatch');

    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), input(root).content);
  });
});

await test('root aliases canonicalize while symlink parents, leaves, and hard links are refused', async () => {
  await temporary(async (container) => {
    const root = join(container, 'root');
    const outside = join(container, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(root, join(container, 'alias'));
    const created = await write(input(join(container, 'alias')));

    assert.equal(created.outcome, 'written');

    if (created.outcome === 'written') {
      assert.equal(created.root, await realpath(root));
    }

    await symlink(outside, join(root, 'linked-parent'));
    blocked(await write({ ...input(root), path: 'linked-parent/file' }), 'unsafe_path');
    await symlink(join(outside, 'missing'), join(root, 'dangling'));
    blocked(await write({ ...input(root), path: 'dangling' }), 'unsafe_path');
    await writeFile(join(outside, 'authored'), 'private-user-value');
    await symlink(join(outside, 'authored'), join(root, 'linked-file'));
    blocked(await write({ ...input(root), path: 'linked-file' }), 'unsafe_path');
    await link(join(outside, 'authored'), join(root, 'hard-linked'));
    blocked(await write({ ...input(root), path: 'hard-linked' }), 'unsafe_path');

    assert.equal(await readFile(join(outside, 'authored'), 'utf8'), 'private-user-value');
    assert.deepEqual(await readdir(outside), ['authored']);
  });
});

await test('missing parents are reported rather than created implicitly', async () => {
  await temporary(async (root) => {
    blocked(await write({ ...input(root), path: 'missing/file' }), 'missing_parent');

    assert.deepEqual(await readdir(root), []);
  });
});

await test('unknown or corrupted metadata is preserved without repair or adoption', async () => {
  await temporary(async (root) => {
    await mkdir(join(root, '.astack-managed'), { mode: 0o700 });
    await writeFile(join(root, '.astack-managed', 'root.json'), 'private-authored-metadata');
    const result = await write(input(root));

    blocked(result, 'metadata_invalid');

    assert.equal(
      await readFile(join(root, '.astack-managed', 'root.json'), 'utf8'),
      'private-authored-metadata',
    );

    await assert.rejects(stat(join(root, 'config.json')), { code: 'ENOENT' });
  });
});

await test('symlinked or writable metadata directories are refused', async () => {
  await temporary(async (root) => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, '.astack-managed'));
    blocked(await write(input(root)), 'unsafe_path');

    assert.deepEqual(await readdir(outside), []);
  });

  await temporary(async (root) => {
    await write(input(root));
    await chmod(join(root, '.astack-managed'), 0o777);
    blocked(await write(input(root, 'upgrade', '2')), 'unsafe_path');
  });
});

for (const phase of ['prepared', 'published', 'recorded'] as const) {
  await test(`interruption at ${phase} retains persistent transaction evidence`, async () => {
    await temporary(async (root) => {
      await write(input(root));
      const store = createNodeManagedFileStore({
        onProgress: async (event) => {
          if (event.phase === phase) {
            throw new Error('private-runtime-detail');
          }
        },
      });
      const result = await write(input(root, 'private-next-content', '2'), store);

      assert.equal(result.outcome, 'pending');
      assert.doesNotMatch(JSON.stringify(result), /private-next-content|private-runtime-detail/);

      const inspection = await inspect(root);

      assert.equal(inspection.outcome, 'inspected');

      if (inspection.outcome === 'inspected') {
        assert.equal(inspection.state, 'pending');
        assert.equal(inspection.pending?.after.assetVersion, '2');
        assert.equal(
          inspection.observation,
          phase === 'prepared' ? 'matches-record' : 'matches-intent',
        );
        assert.equal(inspection.record?.assetVersion, phase === 'recorded' ? '2' : '1');
      }

      const actual = await readFile(join(root, 'config.json'), 'utf8');

      assert.equal(actual, phase === 'prepared' ? input(root).content : 'private-next-content');

      blocked(await write(input(root, 'retry', '3'), createNodeManagedFileStore()), 'busy');
    });
  });
}

await test(
  'a hard process exit leaves an inspectable publication intent',
  { timeout: 10_000 },
  async () => {
    await temporary(async (root) => {
      await write(input(root));
      const entry = new URL('../dist/index.js', import.meta.url).href;
      const source = `
      const { writeManagedFile, createNodeManagedFileStore } = await import(process.argv[1]);
      const store = createNodeManagedFileStore({
        onProgress: async (event) => {
          if (event.phase === 'published') {
            process.exit(71);
          }
        }
      });
      await writeManagedFile({
        schemaVersion: 1, root: process.argv[2], path: 'config.json',
        owner: 'astack:test', assetVersion: '2', content: 'after crash'
      }, store);
    `;
      const child = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', source, entry, root],
        {
          cwd: root,
          env: {},
          encoding: 'utf8',
          timeout: 5000,
        },
      );

      assert.equal(child.status, 71, child.stderr);
      assert.equal(child.stdout, '');

      const inspection = await inspect(root);

      assert.equal(inspection.outcome, 'inspected');

      if (inspection.outcome === 'inspected') {
        assert.equal(inspection.state, 'pending');
        assert.equal(inspection.record?.assetVersion, '1');
      }

      assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'after crash');
    });
  },
);

await test(
  'a competing managed writer is blocked while prepared content stays private',
  { timeout: 10_000 },
  async () => {
    await temporary(async (root) => {
      await write(input(root));
      let prepared: (() => void) | undefined;
      let release: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = createNodeManagedFileStore({
        onProgress: async (event) => {
          if (event.phase === 'prepared') {
            prepared?.();
            await gate;
          }
        },
      });
      const pending = write(input(root, 'second version', '2'), store);
      await ready;

      try {
        assert.equal(await readFile(join(root, 'config.json'), 'utf8'), input(root).content);

        blocked(await write(input(root, 'competing', '3')), 'busy');
      } finally {
        release?.();
      }

      assert.equal((await pending).outcome, 'written');
      assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'second version');
    });
  },
);

await test('edits and newly authored files appearing during preparation are preserved', async () => {
  for (const existing of [false, true]) {
    await temporary(async (root) => {
      if (existing) {
        await write(input(root));
      }

      const store = createNodeManagedFileStore({
        onProgress: async (event) => {
          if (event.phase === 'prepared') {
            await writeFile(join(root, 'config.json'), 'private-user-edit');
          }
        },
      });
      const result = await write(input(root, 'upgrade', '2'), store);

      assert.equal(result.outcome, 'pending');

      if (result.outcome === 'pending') {
        assert.equal(result.reason, 'target_changed');
        assert.equal((await stat(dirname(join(root, result.intent.stagePath)))).mode & 0o077, 0);
      }

      assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'private-user-edit');
    });
  }
});

await test('cancellation before work has no effects; cancellation after preparation retains intent', async () => {
  await temporary(async (root) => {
    const controller = new AbortController();
    controller.abort();
    blocked(await write(input(root), nodeManagedFileStore, controller.signal), 'cancelled');

    assert.deepEqual(await readdir(root), []);
  });

  await temporary(async (root) => {
    await write(input(root));
    const controller = new AbortController();
    const store = createNodeManagedFileStore({
      onProgress: async (event) => {
        if (event.phase === 'prepared') {
          controller.abort();
        }
      },
    });
    const result = await write(input(root, 'cancelled image', '2'), store, controller.signal);

    assert.equal(result.outcome, 'pending');

    if (result.outcome === 'pending') {
      assert.equal(result.reason, 'cancelled');
    }

    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), input(root).content);
  });
});

await test('cancellation after publication finishes ownership recording', async () => {
  await temporary(async (root) => {
    const controller = new AbortController();
    const store = createNodeManagedFileStore({
      onProgress: async (event) => {
        if (event.phase === 'published') {
          controller.abort();
        }
      },
    });
    const result = await write(input(root), store, controller.signal);

    assert.equal(result.outcome, 'written');
    assert.equal((await inspect(root)).outcome, 'inspected');
  });
});

await test('private artifact capabilities preserve ownership and refuse collisions and escapes', async () => {
  await temporary(async (root) => {
    const directory = await createPrivateArtifactDirectory(root, 'astack:test');
    const opened = await openPrivateArtifact(directory, 'output.bin');
    await opened.file.writeFile('private-bytes');
    await opened.file.close();

    assert.equal((await stat(directory.path)).mode & 0o077, 0);
    assert.equal((await stat(opened.path)).mode & 0o077, 0);

    await assert.rejects(openPrivateArtifact(directory, 'output.bin'), { code: 'EEXIST' });
    await assert.rejects(openPrivateArtifact(directory, '../escape'));
    await assert.rejects(openPrivateArtifact(directory, '.astack-artifact.json'));
    await assert.rejects(openPrivateArtifact({ ...directory, owner: 'other' }, 'other.bin'));

    assert.equal(await readFile(opened.path, 'utf8'), 'private-bytes');
  });
});

await test('artifact files cannot follow symlinks or a replaced ownership marker', async () => {
  await temporary(async (root) => {
    const directory = await createPrivateArtifactDirectory(root, 'astack:test');
    const outside = join(root, 'authored');
    await writeFile(outside, 'private-user-content');
    await symlink(outside, join(directory.path, 'linked.bin'));
    await assert.rejects(openPrivateArtifact(directory, 'linked.bin'), { code: 'EEXIST' });
    await writeFile(join(directory.path, '.astack-artifact.json'), '{}');
    await assert.rejects(openPrivateArtifact(directory, 'new.bin'));

    assert.equal(await readFile(outside, 'utf8'), 'private-user-content');
  });
});

await test('inspection retains ownership evidence when an owned target parent was deleted and creates no replacement directories', async () => {
  await temporary(async (root) => {
    await mkdir(join(root, 'nested'));
    const request = { ...input(root), path: 'nested/config.json' };
    const written = await writeManagedFile(request, nodeManagedFileStore);

    assert.equal(written.outcome, 'written');

    await rm(join(root, 'nested'), { recursive: true });
    const inspected = await inspectManagedFile(
      { schemaVersion: 1, root, path: request.path },
      nodeManagedFileStore,
    );

    assert.ok(inspected.outcome === 'inspected');
    assert.equal(inspected.state, 'modified');
    assert.equal(inspected.observation, 'missing');
    assert.equal(inspected.record?.owner, request.owner);

    await assert.rejects(stat(join(root, 'nested')), { code: 'ENOENT' });
  });
});
