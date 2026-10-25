import { resolve, dirname, basename } from 'node:path';
import { canonicalFileRoot, readRegularFile } from '../core/file-paths.js';
/** Stable regular UTF-8 JSON only; file contents never enter command arguments. */
export async function readRequestFile(path: string, limit: number): Promise<unknown> {
  const selected = resolve(process.cwd(), path);
  const root = await canonicalFileRoot(dirname(selected));
  const file = await readRegularFile(root, basename(selected), limit);

  if (!file) {
    throw new Error('Missing request');
  }

  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(file.bytes));
}
