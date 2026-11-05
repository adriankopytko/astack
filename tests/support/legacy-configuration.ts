// Test-only legacy policy fixture for application contract tests; never used by production.
import { lstat } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { projectIdSchema } from '../../src/contracts/project-context.js';
import type { ConfigurationReader } from '../../src/ports/configuration.js';
import {
  canonicalFileRoot,
  hasFileCode,
  readRegularFile,
  type FileSnapshot,
} from '../../src/core/file-paths.js';
import { ConfigurationReadError } from '../../src/core/configuration-error.js';

function privateOwner(info: { mode: number | bigint; uid: number | bigint }): boolean {
  return (
    (BigInt(info.mode) & 0o077n) === 0n &&
    (process.getuid === undefined || BigInt(info.uid) === BigInt(process.getuid()))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (hasFileCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

async function outsideRepository(path: string): Promise<void> {
  let parent = path;

  while (true) {
    if (
      (await exists(join(parent, '.git'))) ||
      ((await exists(join(parent, 'HEAD'))) &&
        (await exists(join(parent, 'objects'))) &&
        (await exists(join(parent, 'config'))))
    ) {
      throw new ConfigurationReadError('configuration_unsafe');
    }

    const next = dirname(parent);

    if (next === parent) {
      return;
    }

    parent = next;
  }
}

async function privateFile(path: string, maximum: number): Promise<FileSnapshot | null> {
  if (!isAbsolute(path)) {
    throw new ConfigurationReadError('configuration_unsafe');
  }

  const parent = dirname(path);

  if (!(await exists(parent))) {
    return null;
  }

  const root = await canonicalFileRoot(parent);

  if (root.path !== parent || !privateOwner(await lstat(parent))) {
    throw new ConfigurationReadError('configuration_unsafe');
  }

  await outsideRepository(parent);
  const file = await readRegularFile(root, basename(path), maximum);

  if (file && !privateOwner(file.info)) {
    throw new ConfigurationReadError('configuration_unsafe');
  }

  return file;
}

function json(file: FileSnapshot | null): unknown {
  if (!file) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(file.bytes),
    );

    if (parsed === null) {
      throw new Error('null is not a configuration document');
    }

    return parsed;
  } catch {
    throw new ConfigurationReadError('configuration_invalid');
  }
}

/** Reads only: never creates config folders, copies proposals, launches hooks or searches cwd. */
export function createNodeConfigurationReader(stateDirectory: string): ConfigurationReader {
  return {
    async readPolicy(projectId, signal) {
      if (signal?.aborted) {
        throw new ConfigurationReadError('configuration_unavailable');
      }

      if (!projectIdSchema.safeParse(projectId).success) {
        throw new ConfigurationReadError('configuration_invalid');
      }

      try {
        return json(await privateFile(join(stateDirectory, 'config', `${projectId}.json`), 65_536));
      } catch (error) {
        throw error instanceof ConfigurationReadError
          ? error
          : new ConfigurationReadError('configuration_unsafe');
      }
    },
    async readProposal(checkoutRoot, signal) {
      if (signal?.aborted) {
        throw new ConfigurationReadError('configuration_unavailable');
      }

      try {
        const root = await canonicalFileRoot(checkoutRoot);

        if (root.path !== checkoutRoot) {
          throw new ConfigurationReadError('configuration_unsafe');
        }

        if (!(await exists(join(checkoutRoot, '.astack')))) {
          return null;
        }

        return json(await readRegularFile(root, '.astack/project.json', 65_536));
      } catch (error) {
        throw error instanceof ConfigurationReadError
          ? error
          : new ConfigurationReadError('configuration_unsafe');
      }
    },
  };
}
