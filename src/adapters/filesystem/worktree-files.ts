import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  canonicalFileRoot,
  checkedFilePath,
  exclusiveFile,
  FileSafetyError,
  hasFileCode,
  readRegularFile,
  sha256,
} from '../../core/file-paths.js';
import { worktreeIntentSchema, type WorktreeIntent } from '../../contracts/worktrees.js';
import type { WorktreeFiles } from '../../ports/worktrees.js';

function marker(intent: WorktreeIntent): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: intent.id,
    token: intent.markerToken,
    intentHash: sha256(JSON.stringify(worktreeIntentSchema.parse(intent))),
  });
}

async function privateDirectory(path: string) {
  const root = await canonicalFileRoot(path);
  const info = await lstat(path);

  if (
    root.path !== path ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new FileSafetyError('unsafe_path');
  }

  return root;
}

async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasFileCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
}

function layout(root: string, intent: WorktreeIntent): void {
  if (
    intent.managedRoot !== root ||
    intent.containerPath !== join(root, intent.id) ||
    intent.checkoutPath !== join(root, intent.id, 'checkout')
  ) {
    throw new FileSafetyError('unsafe_path');
  }
}

async function outsideGit(path: string): Promise<void> {
  let parent = path;

  while (true) {
    if (
      (await exists(join(parent, '.git'))) ||
      ((await exists(join(parent, 'HEAD'))) &&
        (await exists(join(parent, 'objects'))) &&
        (await exists(join(parent, 'config'))))
    ) {
      throw new FileSafetyError('unsafe_path');
    }

    const next = dirname(parent);

    if (next === parent) {
      return;
    }

    parent = next;
  }
}

export function createNodeWorktreeFiles(root: string): WorktreeFiles {
  return {
    async prepare(intent) {
      layout(root, intent);
      await privateDirectory(dirname(root));
      await outsideGit(root);
      await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasFileCode(error, 'EEXIST')) {
          throw error;
        }
      });
      const managed = await privateDirectory(root);
      const containerPath = await checkedFilePath(managed, intent.id);
      await mkdir(containerPath, { mode: 0o700 });
      const container = await privateDirectory(containerPath);
      const file = await exclusiveFile(container, 'ownership.json');

      try {
        await file.writeFile(marker(intent));
        await file.sync();
      } finally {
        await file.close();
      }
    },
    async observe(intent) {
      layout(root, intent);

      if (!(await exists(root))) {
        return { container: 'absent', checkout: 'absent' };
      }

      const managed = await privateDirectory(root);
      const containerPath = await checkedFilePath(managed, intent.id);

      if (!(await exists(containerPath))) {
        return { container: 'absent', checkout: 'absent' };
      }

      const container = await privateDirectory(containerPath);
      const saved = await readRegularFile(container, 'ownership.json', 4096);
      const target = await exists(await checkedFilePath(container, 'checkout'));
      const checkout =
        target === null
          ? 'absent'
          : target.isDirectory() && !target.isSymbolicLink()
            ? 'present'
            : 'unsafe';

      return {
        container: saved?.bytes.toString('utf8') === marker(intent) ? 'owned' : 'unowned',
        checkout,
      };
    },
  };
}
