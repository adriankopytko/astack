import { relative, join } from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import {
  FileSafetyError,
  canonicalFileRoot,
  checkedFilePath,
  hasFileCode,
} from '../../core/file-paths.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { InitializationFiles } from '../../ports/initialization.js';
const pathsAllowed = new Set(['.astack', '.agents', '.agents/skills']);
function safeDirectory(info: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  uid: number;
}) {
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (info.mode & 0o022) === 0 &&
    typeof process.getuid === 'function' &&
    info.uid === process.getuid()
  );
}

export const nodeInitializationFiles: InitializationFiles = {
  async directory(path, anchor) {
    try {
      if (anchor) {
        const selected = await canonicalFileRoot(anchor);
        const nested = relative(selected.path, path);
        await checkedFilePath(selected, nested);
        let parent = selected.path;

        for (const part of nested.split('/').slice(0, -1)) {
          parent = join(parent, part);

          if (!safeDirectory(await lstat(parent))) {
            throw new Error('unsafe_parent');
          }
        }
      }

      const info = await lstat(path).catch((error: unknown) => {
        if (hasFileCode(error, 'ENOENT')) {
          return null;
        }

        throw error;
      });

      if (!info) {
        return completed('missing' as const);
      }

      if (!safeDirectory(info)) {
        throw new Error('unsafe_directory');
      }

      return completed('present' as const);
    } catch (error) {
      if (
        hasFileCode(error, 'ENOENT') ||
        (error instanceof FileSafetyError && error.reason === 'missing_parent')
      ) {
        return completed('missing' as const);
      }

      return rejected(
        'initialization_unavailable',
        'Initialization directories must be owned and safe.',
      );
    }
  },
  async prepare(path, paths, signal) {
    try {
      if (paths.some((name) => !pathsAllowed.has(name))) {
        return rejected('invalid_request', 'Unsupported initialization directory.');
      }

      const root = await canonicalFileRoot(path);

      for (const name of paths) {
        if (!pathsAllowed.has(name)) {
          return rejected(
            'invalid_request',
            'Initialization directory is not part of the supported layout.',
          );
        }

        if (signal?.aborted) {
          return rejected('cancelled', 'Initialization directory setup was cancelled.');
        }

        const target = await checkedFilePath(root, name);

        try {
          await mkdir(target, { mode: 0o700 });
        } catch (error) {
          if (!hasFileCode(error, 'EEXIST')) {
            throw error;
          }
        }

        if (!safeDirectory(await lstat(target))) {
          throw new Error('unsafe_initialization_directory');
        }
      }

      return completed(null);
    } catch {
      return rejected(
        'initialization_unavailable',
        'Use owned initialization directories without symlinks or group/other write access.',
      );
    }
  },
};
