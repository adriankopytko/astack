import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { completed, rejected } from '../contracts/operation-result.js';

const count = z.number().int().min(1).max(64);
const settingsSchema = z.strictObject({
  concurrency: z.strictObject({ global: count.optional(), perAgent: count.optional() }).optional(),
});

/** Read host-wide limits without copying or modifying project configuration. */
export async function readServiceSettings(stateDirectory: string) {
  try {
    const bytes = await readFile(join(stateDirectory, 'service.json'));

    if (bytes.length > 8192) {
      return rejected('invalid_request', 'Astack service.json exceeds 8192 bytes.');
    }

    const parsed = settingsSchema.safeParse(JSON.parse(bytes.toString('utf8')) as unknown);

    return parsed.success
      ? completed(parsed.data)
      : rejected('invalid_request', 'Invalid Astack service.json concurrency settings.');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return completed(settingsSchema.parse({}));
    }

    return rejected('invalid_request', 'Could not read Astack service.json settings.');
  }
}
