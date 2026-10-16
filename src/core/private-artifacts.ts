import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp } from 'node:fs/promises';
import { z } from 'zod';
import {
  canonicalFileRoot,
  checkedFilePath,
  exclusiveFile,
  FileSafetyError,
  readRegularFile,
  type FileRoot,
} from './file-paths.js';

const markerName = '.astack-artifact.json';
const markerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('astack-private-artifacts'),
  id: z.uuid(),
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
});

export interface PrivateArtifactDirectory {
  root: FileRoot;
  path: string;
  id: string;
  owner: string;
}

/** Internal capability for a newly created directory; never adopts or repairs existing paths. */
export async function createPrivateArtifactDirectory(
  parent: string,
  owner: string,
  prefix: 'artifact-' | 'process-' = 'artifact-',
): Promise<PrivateArtifactDirectory> {
  const marker = markerSchema.safeParse({
    schemaVersion: 1,
    kind: 'astack-private-artifacts',
    id: randomUUID(),
    owner,
  });

  if (!marker.success) {
    throw new FileSafetyError('metadata_invalid');
  }

  const parentRoot = await canonicalFileRoot(parent);
  const prefixPath = await checkedFilePath(parentRoot, prefix);
  const path = await mkdtemp(prefixPath);
  await checkedFilePath(parentRoot, prefix);
  const root = await canonicalFileRoot(path);

  if (root.path !== path) {
    throw new FileSafetyError('unsafe_path');
  }

  const file = await exclusiveFile(root, markerName);

  try {
    await file.writeFile(JSON.stringify(marker.data) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }

  return { root, path, id: marker.data.id, owner };
}

export async function openPrivateArtifact(directory: PrivateArtifactDirectory, name: string) {
  if (name.includes('/') || name === markerName) {
    throw new FileSafetyError('unsafe_path');
  }

  await checkedFilePath(directory.root, markerName);
  const info = await lstat(directory.path);

  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new FileSafetyError('unsafe_path');
  }

  const marker = await readRegularFile(directory.root, markerName, 4096);
  let parsed;

  try {
    parsed = markerSchema.parse(
      marker === null ? null : (JSON.parse(marker.bytes.toString('utf8')) as unknown),
    );
  } catch {
    throw new FileSafetyError('metadata_invalid');
  }

  if (
    parsed.id !== directory.id ||
    parsed.owner !== directory.owner ||
    directory.path !== directory.root.path
  ) {
    throw new FileSafetyError('metadata_invalid');
  }

  const absolute = await checkedFilePath(directory.root, name);

  return { file: await exclusiveFile(directory.root, name), path: absolute };
}
