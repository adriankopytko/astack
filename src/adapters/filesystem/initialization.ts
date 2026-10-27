import { relative, join } from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import {
  FileSafetyError,
  canonicalFileRoot,
  checkedFilePath,
  readRegularFile,
  hasFileCode,
} from '../../core/file-paths.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { InitializationFiles } from '../../ports/initialization.js';
import type { InitializationSignals } from '../../contracts/initialization.js';
const pathsAllowed = new Set(['.astack', '.agents', '.agents/skills', 'config']);
const managers = ['pnpm', 'npm', 'yarn', 'bun'] as const;
const scripts = ['test', 'lint', 'typecheck', 'build', 'dev'] as const;
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
  async directory(path, privateRoot = false, anchor) {
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

      if (!safeDirectory(info) || (privateRoot && (info.mode & 0o077) !== 0)) {
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
        'Initialization directories must be owned and safe; private host configuration requires a private parent.',
      );
    }
  },
  async signals(path) {
    try {
      const root = await canonicalFileRoot(path);
      const result: InitializationSignals = {
        stacks: [],
        packageManager: null,
        scripts: [],
        suggestions: [],
        diagnostics: [],
      };
      const read = async (file: string) => {
        try {
          return await readRegularFile(root, file, 65536);
        } catch {
          result.diagnostics.push('stack_signal_unavailable');

          return null;
        }
      };

      const exists = async (file: string) => {
        try {
          const info = await lstat(await checkedFilePath(root, file));

          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
            throw new Error('unsafe_signal');
          }

          return true;
        } catch (error) {
          if (!hasFileCode(error, 'ENOENT')) {
            result.diagnostics.push('stack_signal_unavailable');
          }

          return false;
        }
      };

      const node = await read('package.json');
      let declared: InitializationSignals['packageManager'] = null;

      if (node) {
        result.stacks.push('node');

        try {
          const value: unknown = JSON.parse(
            new TextDecoder('utf8', { fatal: true }).decode(node.bytes),
          );

          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const data = value as Record<string, unknown>;
            declared =
              managers.find(
                (manager) =>
                  typeof data.packageManager === 'string' &&
                  data.packageManager.startsWith(`${manager}@`),
              ) ?? null;

            if (data.scripts && typeof data.scripts === 'object' && !Array.isArray(data.scripts)) {
              const entries = data.scripts as Record<string, unknown>;
              result.scripts = scripts.filter(
                (name) => Object.hasOwn(entries, name) && typeof entries[name] === 'string',
              );
            }
          } else {
            result.diagnostics.push('package_manifest_invalid');
          }
        } catch {
          result.diagnostics.push('package_manifest_invalid');
        }
      }

      const locks: NonNullable<InitializationSignals['packageManager']>[] = [];

      for (const [manager, names] of [
        ['pnpm', ['pnpm-lock.yaml']],
        ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
        ['yarn', ['yarn.lock']],
        ['bun', ['bun.lock', 'bun.lockb']],
      ] as const) {
        let found = false;

        for (const name of names) {
          found ||= await exists(name);
        }

        if (found) {
          locks.push(manager);
        }
      }

      const choices = new Set([...(declared ? [declared] : []), ...locks]);
      result.packageManager = choices.size === 1 ? [...choices][0]! : null;

      if (choices.size > 1) {
        result.diagnostics.push('package_manager_ambiguous');
      }

      if (result.packageManager) {
        result.suggestions = result.scripts
          .filter((script) => ['test', 'lint', 'typecheck'].includes(script))
          .map((script) => ({ hook: 'verify', manager: result.packageManager!, script }));
      }

      for (const [stack, name] of [
        ['rust', 'Cargo.toml'],
        ['python', 'pyproject.toml'],
        ['go', 'go.mod'],
      ] as const) {
        if (await exists(name)) {
          result.stacks.push(stack);
        }
      }

      return completed(result);
    } catch {
      return rejected(
        'initialization_unavailable',
        'Project stack signals could not be inspected.',
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

        if (
          !safeDirectory(await lstat(target)) ||
          (name === 'config' && ((await lstat(target)).mode & 0o077) !== 0)
        ) {
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
