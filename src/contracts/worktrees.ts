import { z } from 'zod';
import { join } from 'node:path';
import { gitRefSchema, gitRepositoryInspectionSchema } from './git.js';
import {
  checkoutIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  checkoutRecordSchema,
} from './project-context.js';
import { checkoutLocationSchema, runBindingSchema } from './projects.js';
import { stateIdSchema } from './state.js';
import { rejectedResultSchema } from './operation-result.js';

const path = checkoutRecordSchema.shape.rootPath;
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const branch = gitRefSchema.shape.name.refine((value) => value.startsWith('refs/heads/'));
export const worktreePrepareRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
  checkoutId: checkoutIdSchema.optional(),
  runId: stateIdSchema.optional(),
  key: stateIdSchema,
  branch,
  baseCommit: gitRefSchema.shape.objectId,
});
export const worktreeIdRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
});
export const worktreeReconcileRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
  operationId: stateIdSchema,
  writerStopped: z.literal(true),
});
export const worktreeIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    key: stateIdSchema,
    projectId: projectIdSchema,
    repositoryId: repositoryIdSchema,
    sourceCheckoutId: checkoutIdSchema,
    checkoutId: checkoutIdSchema,
    sourceRoot: path,
    sourceLocation: checkoutLocationSchema,
    run: runBindingSchema.nullable(),
    branch,
    baseCommit: gitRefSchema.shape.objectId,
    managedRoot: path,
    containerPath: path,
    checkoutPath: path,
    markerToken: stateIdSchema,
    createdAt: timestamp,
  })
  .superRefine((value, context) => {
    if (
      value.containerPath !== join(value.managedRoot, value.id) ||
      value.checkoutPath !== join(value.managedRoot, value.id, 'checkout') ||
      value.sourceRoot !== value.sourceLocation.root.path
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Managed worktree paths must match the owned layout',
      });
    }

    if (
      value.run &&
      (value.run.projectId !== value.projectId ||
        value.run.repositoryId !== value.repositoryId ||
        value.run.checkoutId !== value.sourceCheckoutId ||
        value.run.commit !== value.baseCommit ||
        value.run.branch !== value.branch)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Saved attempt and worktree assignment must agree',
      });
    }
  });
export const worktreeRecordSchema = z
  .strictObject({
    intent: worktreeIntentSchema,
    phase: z.enum(['preparing', 'ready', 'removing', 'removed', 'abandoned']),
    revision: z.number().int().nonnegative(),
    operationId: stateIdSchema,
    location: checkoutLocationSchema.nullable(),
    removalCommit: gitRefSchema.shape.objectId.nullable(),
    reconciliation: z
      .strictObject({
        operationId: stateIdSchema,
        source: z.literal('host-attestation'),
        at: timestamp,
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    if (['removing', 'removed'].includes(value.phase) && value.removalCommit === null) {
      context.addIssue({ code: 'custom', message: 'Removal requires a retained full commit SHA' });
    }

    if (
      value.location &&
      (value.location.root.path !== value.intent.checkoutPath ||
        value.location.commonDirectory.path !== value.intent.sourceLocation.commonDirectory.path)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Recorded worktree location must match its intent',
      });
    }

    if (['ready', 'removing', 'removed'].includes(value.phase) && value.location === null) {
      context.addIssue({
        code: 'custom',
        message: 'Established worktrees require filesystem identity evidence',
      });
    }
  });
export const worktreeObservationSchema = z.strictObject({
  container: z.enum(['absent', 'owned', 'unowned']),
  checkout: z.enum(['absent', 'present', 'unsafe']),
  git: gitRepositoryInspectionSchema.nullable(),
  location: checkoutLocationSchema.nullable(),
  ignoredFiles: z.boolean().nullable(),
});
export const worktreeReasonSchema = z.enum([
  'pending_writer',
  'dirty',
  'ignored_files',
  'unowned',
  'identity_changed',
  'branch_changed',
  'locked',
  'provider_uncertain',
  'provider_refused',
  'resource_in_use',
  'abandoned',
  'cancelled',
  'partial',
]);
export const worktreeResultSchema = z.union([
  rejectedResultSchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('uncertain'),
    error: z.strictObject({ code: z.literal('state_write_uncertain'), message: z.string().min(1) }),
  }),
  z
    .strictObject({
      schemaVersion: z.literal(1),
      outcome: z.enum(['prepared', 'reused', 'removed', 'reconciled', 'inspected']),
      record: worktreeRecordSchema,
      observation: worktreeObservationSchema.nullable(),
    })
    .superRefine((value, context) => {
      if (
        (['prepared', 'reused'].includes(value.outcome) && value.record.phase !== 'ready') ||
        (value.outcome === 'removed' && value.record.phase !== 'removed') ||
        (value.outcome === 'reconciled' && ['preparing', 'removing'].includes(value.record.phase))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Outcome must agree with recorded lifecycle state',
        });
      }
    }),
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.enum(['blocked', 'pending']),
    reason: worktreeReasonSchema,
    record: worktreeRecordSchema,
  }),
]);
export type WorktreeIntent = z.infer<typeof worktreeIntentSchema>;
export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;
export type WorktreeObservation = z.infer<typeof worktreeObservationSchema>;
export type WorktreeReason = z.infer<typeof worktreeReasonSchema>;
export type WorktreeResult = z.infer<typeof worktreeResultSchema>;
export type WorktreePrepareRequest = z.infer<typeof worktreePrepareRequestSchema>;
export type WorktreeReconcileRequest = z.infer<typeof worktreeReconcileRequestSchema>;
