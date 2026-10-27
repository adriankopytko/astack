import { basename, dirname, resolve } from 'node:path';
import { lstat, mkdir, opendir } from 'node:fs/promises';
import { completed, rejected, type OperationResult } from '../../contracts/operation-result.js';
import { canonicalFileRoot, checkedFilePath, hasFileCode } from '../../core/file-paths.js';
import type { SkillDirectories, SkillDirectoryObservation } from '../../ports/skills.js';
const namePattern = /^astack-(?:orchestrator|implementer|reviewer)$/;
async function trustedDirectory(path: string) {
  const info = await lstat(path);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o022) !== 0 ||
    typeof process.getuid !== 'function' ||
    info.uid !== process.getuid()
  ) {
    throw new Error('unsafe_skill_directory');
  }
}

function failure() {
  return rejected(
    'skills_unavailable',
    'Select an owned skills directory (or an existing trusted parent for creation), without writable or symlinked skill subdirectories.',
  );
}

function validate(names: string[]) {
  if (
    names.length < 1 ||
    names.length > 3 ||
    new Set(names).size !== names.length ||
    names.some((name) => !namePattern.test(name))
  ) {
    throw new Error('invalid_skill_directory');
  }
}

async function inspect(
  root: string,
  names: string[],
): Promise<OperationResult<SkillDirectoryObservation>> {
  try {
    validate(names);
    const info = await lstat(root).catch((error: unknown) => {
      if (hasFileCode(error, 'ENOENT')) {
        return null;
      }

      throw error;
    });

    if (info === null) {
      return completed({
        root: resolve(root),
        exists: false,
        directories: names.map((name) => ({ name, state: 'missing' as const })),
      });
    }

    const selected = await canonicalFileRoot(root);
    await trustedDirectory(selected.path);
    const directories: SkillDirectoryObservation['directories'] = [];

    for (const name of names) {
      const path = await checkedFilePath(selected, name);
      const exists = await lstat(path).catch((error: unknown) => {
        if (hasFileCode(error, 'ENOENT')) {
          return null;
        }

        throw error;
      });

      if (!exists) {
        directories.push({ name, state: 'missing' });

        continue;
      }

      await trustedDirectory(path);
      const directory = await opendir(path);

      try {
        directories.push({ name, state: (await directory.read()) === null ? 'empty' : 'present' });
      } finally {
        await directory.close();
      }
    }

    return completed({ root: selected.path, exists: true, directories });
  } catch {
    return failure();
  }
}

export const nodeSkillDirectories: SkillDirectories = {
  inspect,
  async prepare(root, names, signal) {
    try {
      validate(names);

      if (signal?.aborted) {
        return rejected('cancelled', 'Skill directory setup was cancelled.');
      }

      const before = await inspect(root, names);

      if (before.outcome === 'rejected') {
        return before;
      }

      if (!before.value.exists) {
        const parent = await canonicalFileRoot(dirname(root));
        await trustedDirectory(parent.path);
        const selected = await checkedFilePath(parent, basename(root));

        try {
          await mkdir(selected, { mode: 0o700 });
        } catch (error) {
          if (!hasFileCode(error, 'EEXIST')) {
            throw error;
          }
        }

        await trustedDirectory(selected);
      }

      const selected = await canonicalFileRoot(root);
      await trustedDirectory(selected.path);

      for (const name of names) {
        if (signal?.aborted) {
          return rejected(
            'cancelled',
            'Skill directory setup was cancelled; empty prepared directories may remain.',
          );
        }

        const path = await checkedFilePath(selected, name);

        try {
          await mkdir(path, { mode: 0o700 });
        } catch (error) {
          if (!hasFileCode(error, 'EEXIST')) {
            throw error;
          }
        }

        await trustedDirectory(path);
      }

      return await inspect(selected.path, names);
    } catch {
      return failure();
    }
  },
};
