import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createOperationResultSchema } from './operation-result.js';

export function hasGitControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);

    if (code <= 32 || code === 127) {
      return true;
    }
  }

  return false;
}

const path = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const refName = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !hasGitControlCharacters(value) &&
      !/[~^:?*[\\]/.test(value) &&
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.includes('..') &&
      !value.includes('@{') &&
      value !== '@' &&
      value
        .split('/')
        .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock')),
  );
const fullRefName = refName.refine((value) => value.startsWith('refs/'));
const entryPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !value.startsWith('/') &&
      value
        .replace(/\/$/, '')
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
  );

export const gitInspectionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  path,
  baseRef: refName.optional(),
});
export const gitHeadSchema = z
  .strictObject({
    branch: fullRefName.nullable(),
    commit: objectId.nullable(),
  })
  .refine((value) => value.branch !== null || value.commit !== null);
export const gitRefSchema = z.strictObject({
  name: fullRefName,
  objectId,
  objectType: z.enum(['commit', 'tag', 'tree', 'blob']),
});
export const gitStatusEntrySchema = z
  .strictObject({
    kind: z.enum(['ordinary', 'renamed', 'unmerged', 'untracked']),
    path: entryPath,
    originalPath: entryPath.nullable(),
    indexStatus: z.string().regex(/^[.MADRCUT?!]$/),
    worktreeStatus: z.string().regex(/^[.MADRCUT?!]$/),
    submodule: z
      .string()
      .regex(/^(?:N\.\.\.|S[.C][.M][.U])$/)
      .nullable(),
  })
  .superRefine((value, context) => {
    if (
      (value.kind === 'renamed') !== (value.originalPath !== null) ||
      (value.kind === 'untracked') !== (value.submodule === null)
    ) {
      context.addIssue({ code: 'custom', message: 'Entry evidence does not match its kind' });
    }
  });
export const gitWorktreeSchema = z.strictObject({
  path,
  head: objectId.nullable(),
  branch: fullRefName.nullable(),
  bare: z.boolean(),
  detached: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
});
export const gitRemoteEndpointSchema = z.strictObject({
  transport: z.enum(['http', 'https', 'ssh', 'git', 'file', 'other']),
  host: z
    .string()
    .regex(/^[a-z0-9.:[\]-]+$/)
    .nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
});
export const gitRepositoryInspectionSchema = z
  .strictObject({
    repository: z.strictObject({ commonDirectory: path, objectFormat: z.enum(['sha1', 'sha256']) }),
    checkout: z.strictObject({ rootPath: path, gitDirectory: path, head: gitHeadSchema }),
    refs: z.array(gitRefSchema),
    base: z
      .strictObject({ requestedRef: refName, fullRef: fullRefName.nullable(), commit: objectId })
      .nullable(),
    remotes: z.array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .refine((value) => !hasGitControlCharacters(value)),
        fetch: z.array(gitRemoteEndpointSchema),
        push: z.array(gitRemoteEndpointSchema),
      }),
    ),
    worktrees: z.array(gitWorktreeSchema),
    status: z
      .strictObject({ clean: z.boolean(), entries: z.array(gitStatusEntrySchema) })
      .refine((value) => value.clean === (value.entries.length === 0)),
  })
  .superRefine((value, context) => {
    const length = value.repository.objectFormat === 'sha1' ? 40 : 64;
    const ids = [
      value.checkout.head.commit,
      value.base?.commit,
      ...value.refs.map((ref) => ref.objectId),
      ...value.worktrees.map((tree) => tree.head),
    ];

    if (ids.some((id) => id != null && id.length !== length)) {
      context.addIssue({ code: 'custom', message: 'Object IDs must match repository format' });
    }
  });
export const gitInspectionResultSchema = createOperationResultSchema(gitRepositoryInspectionSchema);
export type GitInspectionRequest = z.infer<typeof gitInspectionRequestSchema>;
export type GitRepositoryInspection = z.infer<typeof gitRepositoryInspectionSchema>;
export type GitInspectionResult = z.infer<typeof gitInspectionResultSchema>;
export type GitHead = z.infer<typeof gitHeadSchema>;
export type GitRef = z.infer<typeof gitRefSchema>;
export type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>;
export type GitWorktree = z.infer<typeof gitWorktreeSchema>;
export type GitRemoteEndpoint = z.infer<typeof gitRemoteEndpointSchema>;
