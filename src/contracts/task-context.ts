import { z } from 'zod';
import { configurationDigestSchema } from './configuration.js';

export const instructionPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !value.includes('\0') &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git') &&
      value.endsWith('.md') &&
      !/[\r\n]/u.test(value),
  );
export const instructionReferenceSchema = z.strictObject({
  path: instructionPathSchema,
  digest: configurationDigestSchema.nullable(),
});
export type InstructionReference = z.infer<typeof instructionReferenceSchema>;

export const issueReferenceSchema = z.strictObject({
  host: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/)
    .refine((value) => !value.includes('..')),
  repository: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/),
  number: z.number().int().positive().max(2147483647),
});

/** A PR's exact commit, independent of the agent's purpose. */
export const pullRequestCommitTargetSchema = issueReferenceSchema.extend({
  sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type PullRequestCommitTarget = z.infer<typeof pullRequestCommitTargetSchema>;
