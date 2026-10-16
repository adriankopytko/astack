import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { relativeFilePathSchema, type FileProblem } from '../contracts/managed-files.js';

export class FileSafetyError extends Error {
  constructor(readonly reason: FileProblem) {
    super(reason);
  }
}

export function hasFileCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

export function fileProblem(error: unknown): FileProblem {
  return error instanceof FileSafetyError ? error.reason : 'io_failed';
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface FileRoot {
  path: string;
  device: bigint;
  inode: bigint;
}

export async function canonicalFileRoot(path: string): Promise<FileRoot> {
  const canonical = await realpath(path);
  const info = await lstat(canonical, { bigint: true });

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new FileSafetyError('unsafe_path');
  }

  return { path: canonical, device: info.dev, inode: info.ino };
}

export async function checkedFilePath(root: FileRoot, relative: string): Promise<string> {
  if (!relativeFilePathSchema.safeParse(relative).success) {
    throw new FileSafetyError('unsafe_path');
  }

  const info = await lstat(root.path, { bigint: true });

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== root.device ||
    info.ino !== root.inode
  ) {
    throw new FileSafetyError('unsafe_path');
  }

  const parts = relative.split('/');
  let parent = root.path;

  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const directory = await lstat(parent).catch((error: unknown) => {
      if (hasFileCode(error, 'ENOENT')) {
        throw new FileSafetyError('missing_parent');
      }

      throw error;
    });

    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new FileSafetyError('unsafe_path');
    }
  }

  return join(root.path, ...parts);
}

export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export interface FileSnapshot {
  bytes: Buffer;
  info: BigIntStats;
  sha256: string;
}

export async function readRegularFile(
  root: FileRoot,
  relative: string,
  maximum: number,
): Promise<FileSnapshot | null> {
  const path = await checkedFilePath(root, relative);
  const before = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (hasFileCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  });

  if (!before) {
    return null;
  }

  if (!before.isFile() || before.nlink !== 1n || before.isSymbolicLink()) {
    throw new FileSafetyError('unsafe_path');
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const opened = await handle.stat({ bigint: true });

    if (!opened.isFile() || opened.nlink !== 1n || !sameSnapshot(before, opened)) {
      throw new FileSafetyError('target_changed');
    }

    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;

    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length);

      if (bytesRead === 0) {
        break;
      }

      length += bytesRead;
    }

    if (length > maximum) {
      throw new FileSafetyError('modified_file');
    }

    const after = await handle.stat({ bigint: true });

    if (!sameSnapshot(opened, after)) {
      throw new FileSafetyError('target_changed');
    }

    const bytes = buffer.subarray(0, length);

    return { bytes, info: after, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

export async function exclusiveFile(root: FileRoot, relative: string) {
  const path = await checkedFilePath(root, relative);

  return open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
}
