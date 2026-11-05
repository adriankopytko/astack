import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { projectIdSchema } from '../../contracts/project-context.js';
import type { ProjectRegistry } from '../../ports/project-registry.js';
import type { StateStore } from '../../ports/state-store.js';
import type { ConfigurationDiagnostic } from '../../contracts/configuration.js';
import type { ConfigurationReader, ConfigurationProbe } from '../../ports/configuration.js';
import {
  canonicalFileRoot,
  hasFileCode,
  readRegularFile,
  type FileSnapshot,
} from '../../core/file-paths.js';
import { ConfigurationReadError } from '../../core/configuration-error.js';

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

export async function readProjectConfiguration(
  checkoutRoot: string,
): Promise<{ value: unknown; digest: string } | null> {
  const root = await canonicalFileRoot(checkoutRoot);

  if (root.path !== checkoutRoot) {
    throw new ConfigurationReadError('configuration_unsafe');
  }

  if (!(await exists(join(checkoutRoot, '.astack')))) {
    return null;
  }

  const file = await readRegularFile(root, '.astack/config.json', 65_536);

  return file ? { value: json(file), digest: file.sha256 } : null;
}

/** Reads only: never creates config folders, copies proposals, launches hooks or searches cwd. */
export function createNodeConfigurationReader(
  registry: ProjectRegistry,
  state?: Pick<StateStore, 'readJobConfiguration'>,
): ConfigurationReader {
  return {
    async readJobPolicy(jobId, signal) {
      if (signal?.aborted || !state) {
        return null;
      }

      const result = state.readJobConfiguration(jobId);

      if (result.outcome === 'rejected') {
        throw new ConfigurationReadError('configuration_unavailable');
      }

      return result.value;
    },
    async readPolicy(projectId, signal) {
      if (signal?.aborted) {
        throw new ConfigurationReadError('configuration_unavailable');
      }

      if (!projectIdSchema.safeParse(projectId).success) {
        throw new ConfigurationReadError('configuration_invalid');
      }

      try {
        const project = await registry.readProject(projectId);

        if (project.outcome === 'rejected') {
          throw new ConfigurationReadError('configuration_unavailable');
        }

        if (project.value) {
          const checkout = await registry.readCheckout(project.value.project.primaryCheckoutId);

          if (checkout.outcome === 'rejected' || !checkout.value?.registered) {
            throw new ConfigurationReadError('configuration_unavailable');
          }

          const config = await readProjectConfiguration(checkout.value.checkout.rootPath);
          const value = config?.value ?? null;

          if (value !== null) {
            if (typeof value !== 'object' || Array.isArray(value)) {
              throw new ConfigurationReadError('configuration_invalid');
            }

            return { ...value, projectId, repositoryId: project.value.repository.id };
          }
        }

        return null;
      } catch (error) {
        throw error instanceof ConfigurationReadError
          ? error
          : new ConfigurationReadError('configuration_unsafe');
      }
    },
    async readProposal(_checkoutRoot, signal) {
      if (signal?.aborted) {
        throw new ConfigurationReadError('configuration_unavailable');
      }

      return null;
    },
  };
}

/** Environment lookup returns presence only; values never leave the host adapter. */
export function createNodeConfigurationProbe(
  environmentPresent: (name: string) => boolean,
): ConfigurationProbe {
  return {
    async inspect(input, signal) {
      const diagnostics: ConfigurationDiagnostic[] = [];

      for (const command of input.commands) {
        if (signal?.aborted) {
          throw new ConfigurationReadError('configuration_unavailable');
        }

        try {
          await access(command.executable, constants.X_OK);

          if (!(await stat(command.executable)).isFile()) {
            throw new Error('not executable');
          }
        } catch {
          diagnostics.push({
            code: 'executable_missing',
            subject: command.id,
            nextStep:
              'Install the configured executable or update its absolute path in .astack/config.json.',
          });
        }
      }

      for (const variable of input.environment) {
        if (!environmentPresent(variable)) {
          diagnostics.push({
            code: 'environment_missing',
            subject: variable,
            nextStep:
              'Make the configured variable available to the host; do not put its value in configuration or reports.',
          });
        }
      }

      for (const skill of input.skills) {
        try {
          const file = await privateFile(skill.path, 1_048_576);

          if (!file || file.sha256 !== skill.digest) {
            throw new Error('skill missing or changed');
          }
        } catch {
          diagnostics.push({
            code: 'skill_unavailable',
            subject: skill.id,
            nextStep:
              'Restore the configured private skill bytes or update its version and digest in .astack/config.json.',
          });
        }
      }

      return diagnostics;
    },
  };
}
