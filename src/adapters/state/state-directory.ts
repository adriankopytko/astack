import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalFileRoot,
  checkedFilePath,
  exclusiveFile,
  hasFileCode,
  readRegularFile,
  type FileRoot,
} from '../../core/file-paths.js';
import { stateFailure } from './errors.js';

const markerName = '.astack-state.json';
const markerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('astack-state'),
  id: z.uuid(),
});
const databaseNames = [
  'state.sqlite',
  'state.sqlite-wal',
  'state.sqlite-shm',
  'state.sqlite-journal',
];

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
      stateFailure('state_directory_unsafe');
    }

    const next = dirname(parent);

    if (next === parent) {
      return;
    }

    parent = next;
  }
}

async function canonicalTarget(path: string): Promise<string> {
  let parent = resolve(path);
  const suffix: string[] = [];

  while (true) {
    try {
      const canonical = await realpath(parent);

      return join(canonical, ...suffix);
    } catch (error) {
      if (!hasFileCode(error, 'ENOENT') || dirname(parent) === parent) {
        throw error;
      }

      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

function privateOwner(info: { mode: number; uid: number }): boolean {
  return (
    (info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid())
  );
}

export async function auditStateFiles(root: FileRoot): Promise<void> {
  await checkedFilePath(root, markerName);
  const directory = await lstat(root.path);

  if (!privateOwner(directory)) {
    stateFailure('state_directory_unsafe');
  }

  for (const name of databaseNames) {
    const path = await checkedFilePath(root, name);
    const info = await lstat(path).catch((error: unknown) => {
      if (hasFileCode(error, 'ENOENT')) {
        return null;
      }

      throw error;
    });

    if (
      info &&
      (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !privateOwner(info))
    ) {
      stateFailure('state_directory_unsafe');
    }
  }
}

export async function prepareStateDirectory(
  selected?: string,
  readOnly = false,
): Promise<{ root: FileRoot; databasePath: string }> {
  const target = await canonicalTarget(selected ?? join(homedir(), '.local', 'state', 'astack'));
  await outsideRepository(target);

  if (readOnly && !(await exists(target))) {
    stateFailure('state_not_found');
  }

  if (!readOnly) {
    await mkdir(target, { recursive: true, mode: 0o700 });
  }

  const root = await canonicalFileRoot(target);
  await outsideRepository(root.path);

  if (!privateOwner(await lstat(root.path))) {
    stateFailure('state_directory_unsafe');
  }

  let marker = await readRegularFile(root, markerName, 4096);

  if (marker === null) {
    const contents = await opendir(root.path);
    let empty: boolean;

    try {
      empty = (await contents.read()) === null;
    } finally {
      await contents.close();
    }

    if (!empty) {
      stateFailure('state_directory_unsafe');
    }

    if (readOnly) {
      stateFailure('state_not_found');
    }

    try {
      const file = await exclusiveFile(root, markerName);

      try {
        await file.writeFile(
          JSON.stringify({ schemaVersion: 1, kind: 'astack-state', id: randomUUID() }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!hasFileCode(error, 'EEXIST')) {
        throw error;
      }
    }

    marker = await readRegularFile(root, markerName, 4096);
  }

  let parsed: unknown;

  try {
    parsed = marker === null ? null : JSON.parse(marker.bytes.toString('utf8'));
  } catch {
    stateFailure('state_directory_unsafe');
  }

  if (!marker || !markerSchema.safeParse(parsed).success || (marker.info.mode & 0o077n) !== 0n) {
    stateFailure('state_directory_unsafe');
  }

  await auditStateFiles(root);
  const databasePath = await checkedFilePath(root, 'state.sqlite');

  if (!(await exists(databasePath))) {
    if (readOnly) {
      stateFailure('state_directory_unsafe');
    }

    if (
      (await Promise.all(databaseNames.slice(1).map((name) => exists(join(root.path, name))))).some(
        Boolean,
      )
    ) {
      stateFailure('state_directory_unsafe');
    }

    try {
      const file = await exclusiveFile(root, 'state.sqlite');
      await file.close();
    } catch (error) {
      if (!hasFileCode(error, 'EEXIST')) {
        throw error;
      }
    }
  }

  await auditStateFiles(root);

  return { root, databasePath };
}
