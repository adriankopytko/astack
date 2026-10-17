import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { canonicalFileRoot, readRegularFile, hasFileCode, type FileRoot } from './file-paths.js';

export const serviceSocketName = 'service.sock';
export const serviceEndpointName = 'service-endpoint.json';
export const endpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  device: z.string(),
  inode: z.string(),
});

export function privateOwner(info: { mode: number | bigint; uid: number | bigint }): boolean {
  return (
    (BigInt(info.mode) & 0o077n) === 0n &&
    (process.getuid === undefined || BigInt(info.uid) === BigInt(process.getuid()))
  );
}

export async function serviceRoot(stateDirectory: string): Promise<FileRoot> {
  const root = await canonicalFileRoot(stateDirectory);

  if (root.path !== stateDirectory || !privateOwner(await lstat(root.path))) {
    throw new Error('Unsafe service root');
  }

  return root;
}

export async function endpointEvidence(root: FileRoot) {
  const file = await readRegularFile(root, serviceEndpointName, 4096);
  const info = await lstat(`${root.path}/${serviceSocketName}`, { bigint: true }).catch(
    (error: unknown) => {
      if (hasFileCode(error, 'ENOENT')) {
        return null;
      }

      throw error;
    },
  );
  const parsed = file
    ? endpointSchema.parse(
        JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(file.bytes)) as unknown,
      )
    : null;

  if (
    (file && !privateOwner(file.info)) ||
    (info && (!info.isSocket() || !privateOwner(info))) ||
    (info && (!parsed || parsed.device !== String(info.dev) || parsed.inode !== String(info.ino)))
  ) {
    throw new Error('Endpoint ownership is uncertain');
  }

  return { file, info, record: parsed };
}
