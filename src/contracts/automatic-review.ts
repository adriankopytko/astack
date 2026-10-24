import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  stateIdSchema,
  createStateWriteResultSchema,
  stateUncertainResultSchema,
} from './state.js';
import { createOperationResultSchema } from './operation-result.js';
import { reviewTargetSchema, reviewGatePolicySchema } from './review-task.js';
import { implementationSubmitRequestSchema, instructionPathSchema } from './implementation-task.js';
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const reviewAutomationSchema = z.strictObject({
  projectId: stateIdSchema,
  enabled: z.boolean(),
  revision: time,
  updatedAt: time,
});
export const reviewAutomationReadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: stateIdSchema,
});
export const reviewAutomationSetSchema = reviewAutomationReadSchema.extend({
  enabled: z.boolean(),
  expectedRevision: time,
});
export const followUpEnqueueSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  handoffKey: stateIdSchema.optional(),
  checkoutId: stateIdSchema,
  branch: implementationSubmitRequestSchema.shape.branch,
  commit: reviewTargetSchema.shape.sha,
  timeoutMs: z.number().int().min(1000).max(604800000).default(3600000),
});
export const followUpPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    request: followUpEnqueueSchema,
    projectId: stateIdSchema,
    repositoryId: stateIdSchema,
    handoffId: stateIdSchema,
    followUpId: stateIdSchema,
    target: reviewTargetSchema,
    gate: reviewGatePolicySchema,
    instructionPaths: z.array(instructionPathSchema).max(8),
    worktreeId: stateIdSchema,
    root: z.string().min(1).max(4096).refine(isAbsolute),
    policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    phase: z.enum([
      'waiting',
      'queued',
      'suspended',
      'blocked',
      'dispatched',
      'satisfied',
      'cancelled',
    ]),
    reason: z.string().max(128).nullable(),
    revision: time,
    automationRevision: time,
    ciGeneration: time,
    ciId: stateIdSchema,
    reviewKey: stateIdSchema,
    reviewJobId: stateIdSchema.nullable(),
    createdAt: time,
    updatedAt: time,
  })
  .refine(
    (v) => v.request.commit === v.target.sha && Buffer.byteLength(JSON.stringify(v)) <= 14000,
  );
export const followUpReadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
});
export const followUpControlSchema = followUpReadSchema.extend({
  action: z.enum(['suspend', 'resume', 'cancel']),
  expectedRevision: time,
});
export const followUpListRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: stateIdSchema,
  after: z.union([z.literal(''), stateIdSchema]).default(''),
  limit: z.number().int().min(1).max(100).default(20),
});
export const followUpListSchema = z.strictObject({
  items: z.array(followUpPlanSchema).max(100),
  nextCursor: stateIdSchema.nullable(),
});
export const reviewAutomationReadResultSchema = createOperationResultSchema(reviewAutomationSchema);
export const reviewAutomationWriteResultSchema =
  createStateWriteResultSchema(reviewAutomationSchema);
export const followUpReadResultSchema = createOperationResultSchema(followUpPlanSchema.nullable());
export const followUpWriteResultSchema = createStateWriteResultSchema(followUpPlanSchema);
export const followUpListResultSchema = createOperationResultSchema(followUpListSchema);
export const followUpDispatchResultSchema = z.union([
  createOperationResultSchema(
    z.strictObject({
      processed: z.number().int().min(0).max(32),
      nextCursor: stateIdSchema.nullable(),
    }),
  ),
  stateUncertainResultSchema,
]);
export type ReviewAutomation = z.infer<typeof reviewAutomationSchema>;
export type FollowUpPlan = z.infer<typeof followUpPlanSchema>;
