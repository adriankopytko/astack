#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createProgram } from './program.js';

const manifest: unknown = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);
const { version } = z.object({ version: z.string() }).parse(manifest);
await createProgram(version).parseAsync(process.argv);
