import { lstat, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  managedMetadataDirectory as metadata,
  managedFileRecordSchema,
  managedWriteIntentSchema,
  maximumManagedFileBytes,
  type ManagedFileRecord,
  type ManagedWriteIntent,
} from '../contracts/managed-files.js';
import {
  checkedFilePath,
  exclusiveFile,
  FileSafetyError,
  hasFileCode,
  readRegularFile,
  sha256,
  type FileRoot,
  type FileSnapshot,
} from './file-paths.js';

const markerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('astack-managed-files'),
});
const markerBytes = JSON.stringify({ schemaVersion: 1, kind: 'astack-managed-files' }) + '\n';

export function metadataPaths(path: string) {
  const key = sha256(path);

  return { record: `${metadata}/${key}.json`, pending: `${metadata}/${key}.pending.json` };
}

export function stagePath(path: string, transactionId: string): string {
  const slash = path.lastIndexOf('/');
  const prefix = slash === -1 ? '' : path.slice(0, slash + 1);

  return `${prefix}.astack-stage-${transactionId}/content`;
}

export async function hasMetadata(root: FileRoot): Promise<boolean> {
  const directory = await checkedFilePath(root, metadata);
  const info = await lstat(directory).catch((error: unknown) => {
    if (hasFileCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  });

  if (!info) {
    return false;
  }

  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
    throw new FileSafetyError('unsafe_path');
  }

  const marker = await readRegularFile(root, `${metadata}/root.json`, 1024);

  try {
    markerSchema.parse(
      marker === null ? null : (JSON.parse(marker.bytes.toString('utf8')) as unknown),
    );
  } catch {
    throw new FileSafetyError('metadata_invalid');
  }

  return true;
}

export async function ensureMetadata(root: FileRoot): Promise<void> {
  if (await hasMetadata(root)) {
    return;
  }

  const directory = await checkedFilePath(root, metadata);

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (hasFileCode(error, 'EEXIST')) {
      await hasMetadata(root);

      return;
    }

    throw error;
  }

  const handle = await exclusiveFile(root, `${metadata}/root.json`);

  try {
    await handle.writeFile(markerBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function loadRecord(
  root: FileRoot,
  path: string,
): Promise<{ record: ManagedFileRecord | null; snapshot: FileSnapshot | null }> {
  if (!(await hasMetadata(root))) {
    return { record: null, snapshot: null };
  }

  const snapshot = await readRegularFile(root, metadataPaths(path).record, maximumManagedFileBytes);

  if (!snapshot) {
    return { record: null, snapshot: null };
  }

  try {
    const record = managedFileRecordSchema.parse(
      JSON.parse(snapshot.bytes.toString('utf8')) as unknown,
    );

    if (record.path !== path) {
      throw new Error('Mismatched record');
    }

    return { record, snapshot };
  } catch {
    throw new FileSafetyError('metadata_invalid');
  }
}

export async function loadPending(
  root: FileRoot,
  path: string,
): Promise<ManagedWriteIntent | null> {
  if (!(await hasMetadata(root))) {
    return null;
  }

  const snapshot = await readRegularFile(
    root,
    metadataPaths(path).pending,
    maximumManagedFileBytes,
  );

  if (!snapshot) {
    return null;
  }

  try {
    const intent = managedWriteIntentSchema.parse(
      JSON.parse(snapshot.bytes.toString('utf8')) as unknown,
    );

    if (
      intent.after.path !== path ||
      (intent.before && intent.before.path !== path) ||
      intent.stagePath !== stagePath(path, intent.transactionId)
    ) {
      throw new Error('Mismatched intent');
    }

    return intent;
  } catch {
    throw new FileSafetyError('metadata_invalid');
  }
}
