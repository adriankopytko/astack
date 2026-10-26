import { z } from 'zod';
import { stateIdSchema, createStateWriteResultSchema } from './state.js';
import { createOperationResultSchema } from './operation-result.js';
import { gitRefSchema } from './git.js';
import { runReconcileRequestSchema } from './run-reconciliation.js';
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const cleanupRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  key: stateIdSchema,
  automatic: z.boolean().default(false),
  notBefore: time,
  publication: z.enum(['required', 'not_required']).default('required'),
});
export const cleanupReadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
});
export const cleanupExecuteSchema = cleanupReadSchema.extend({
  expectedRevision: time,
  shutdown: runReconcileRequestSchema.optional(),
});
export const cleanupControlSchema = cleanupReadSchema.extend({
  expectedRevision: time,
  action: z.enum(['suspend', 'resume', 'cancel']),
});
export const cleanupReconcileSchema = cleanupReadSchema.extend({
  expectedRevision: time,
  writersStopped: z.literal(true),
});
export const cleanupPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
  request: cleanupRequestSchema,
  projectId: stateIdSchema,
  repositoryId: stateIdSchema,
  attemptId: stateIdSchema,
  checkoutId: stateIdSchema,
  worktreeId: stateIdSchema,
  branch: gitRefSchema.shape.name,
  commit: gitRefSchema.shape.objectId,
  reportId: stateIdSchema.nullable(),
  phase: z.enum(['requested', 'started', 'blocked', 'suspended', 'completed', 'cancelled']),
  reason: z.string().min(1).max(128).nullable(),
  revision: time,
  createdAt: time,
  updatedAt: time,
});
export const cleanupReadResultSchema = createOperationResultSchema(cleanupPlanSchema.nullable());
export const cleanupWriteResultSchema = createStateWriteResultSchema(cleanupPlanSchema);
export type CleanupPlan = z.infer<typeof cleanupPlanSchema>;
export type CleanupRequest = z.infer<typeof cleanupRequestSchema>;
