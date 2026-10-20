import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { reviewTargetSchema } from './review-task.js';
import { stateIdSchema } from './state.js';
import type { CompletedResult, RejectedResult, OperationErrorCode } from './operation-result.js';

export const githubRepositorySchema = reviewTargetSchema.pick({ host: true, repository: true });
const sha = reviewTargetSchema.shape.sha;
export const githubBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith('-') &&
      noControls(value) &&
      !/[\s~^:?*[\\]/.test(value) &&
      value !== '@' &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.includes('//') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')),
  );
const body = z
  .string()
  .max(8000)
  .refine(
    (value) =>
      Buffer.byteLength(value) <= 8000 && !value.includes('\0') && !value.includes('<!-- astack:'),
  );
const noControls = (value: string) =>
  Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const actor = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?$/);
export const githubPublicationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('pull-request'),
    target: githubRepositorySchema,
    actor,
    sourceRepository: githubRepositorySchema.shape.repository,
    headBranch: githubBranchSchema,
    headSha: sha,
    baseBranch: githubBranchSchema,
    baseSha: sha,
    title: z.string().min(1).max(256).refine(noControls),
    body,
    draft: z.boolean(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('comment'),
    target: reviewTargetSchema,
    actor,
    body,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('review'),
    target: reviewTargetSchema,
    actor,
    body,
    event: z.enum(['COMMENT', 'REQUEST_CHANGES']),
  }),
]);
export const githubPullRequestSchema = z.strictObject({
  target: reviewTargetSchema,
  baseSha: sha,
  baseBranch: githubBranchSchema,
  headBranch: githubBranchSchema,
  sourceRepository: githubRepositorySchema.shape.repository.nullable(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  draft: z.boolean(),
  title: z.string().max(256),
  body: z.string().max(65536),
  author: actor,
});
export const githubPublicationReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.enum(['pull-request', 'comment', 'review']),
    marker: z.string().regex(/^<!-- astack:publication:v1:[0-9a-f]{64} -->$/),
    target: reviewTargetSchema,
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    actor,
    observedAt: z.number().int().nonnegative(),
  })
  .refine((value) => value.kind !== 'pull-request' || value.id === value.target.number);
export const githubEffectRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  effectId: stateIdSchema,
  root: z.string().refine(isAbsolute),
  mode: z.enum(['publish', 'reconcile']),
  originalWriterStopped: z.boolean().default(false),
});
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export type GithubPublication = z.infer<typeof githubPublicationSchema>;
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>;
export type GithubPublicationReceipt = z.infer<typeof githubPublicationReceiptSchema>;
export type GithubFailure = RejectedResult & {
  error: RejectedResult['error'] & { retryAfterMs?: number };
};
export type GithubResult<T> = CompletedResult<T> | GithubFailure;
export type GithubWriteResult<T> =
  | GithubResult<T>
  | {
      schemaVersion: 1;
      outcome: 'uncertain';
      error: {
        code: 'github_write_uncertain';
        message: string;
        cause?: OperationErrorCode;
        retryAfterMs?: number;
      };
    };
