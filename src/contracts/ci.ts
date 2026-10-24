import { z } from 'zod';
import { isAbsolute } from 'node:path';
import {
  stateIdSchema,
  createStateWriteResultSchema,
  stateUncertainResultSchema,
} from './state.js';
import { reviewTargetSchema, reviewGatePolicySchema, reviewSnapshotSchema } from './review-task.js';
import { operationErrorSchema, createOperationResultSchema } from './operation-result.js';
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timeout = z.number().int().min(1000).max(604800000);
export const ciSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('handoff'),
    jobId: stateIdSchema,
    key: stateIdSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('review'), jobId: stateIdSchema }),
]);
export const ciWatchRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: ciSourceSchema,
  automaticReviewPlanId: stateIdSchema.optional(),
  key: stateIdSchema,
  timeoutMs: timeout.default(3600000),
});
export const ciPolicySchema = z
  .strictObject({
    intervalMs: z.number().int().min(1000).max(3600000).default(30000),
    maxIntervalMs: z.number().int().min(1000).max(86400000).default(300000),
    maxRequestsPerObservation: z.number().int().min(4).max(202).default(10),
    requestsPerWindow: z.number().int().min(4).max(10000).default(60),
    windowMs: z.number().int().min(1000).max(3600000).default(60000),
    leaseMs: z.number().int().min(60000).max(300000).default(60000),
    maxTargetsPerTick: z.number().int().min(1).max(32).default(4),
  })
  .refine(
    (v) => v.intervalMs <= v.maxIntervalMs && v.requestsPerWindow >= v.maxRequestsPerObservation,
  );
export const ciBindingSchema = z.strictObject({
  projectId: stateIdSchema,
  repositoryId: stateIdSchema,
  sourceId: stateIdSchema,
  checkoutId: stateIdSchema,
  root: z.string().min(1).max(4096).refine(isAbsolute),
  target: reviewTargetSchema,
  gate: reviewGatePolicySchema,
  baseSha: reviewTargetSchema.shape.sha.nullable(),
  policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const ciPhaseSchema = z.enum([
  'watching',
  'ready',
  'blocked',
  'suspended',
  'cancelled',
  'completed',
]);
export const ciRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    request: ciWatchRequestSchema,
    binding: ciBindingSchema,
    targetId: stateIdSchema,
    phase: ciPhaseSchema,
    reason: z.string().max(128).nullable(),
    revision: time,
    createdAt: time,
    updatedAt: time,
    deadlineAt: time,
  })
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 14000);
export const ciParticipantSchema = z.strictObject({ id: stateIdSchema, revision: time });
export const ciTargetSchema = z
  .strictObject({
    id: stateIdSchema,
    target: reviewTargetSchema,
    nextRefreshAt: time,
    lastObservedAt: time.nullable(),
    snapshot: reviewSnapshotSchema.nullable(),
    error: operationErrorSchema.shape.code.nullable(),
    backoff: z.number().int().min(0).max(32),
    claim: z
      .strictObject({
        owner: stateIdSchema,
        token: stateIdSchema,
        startedAt: time,
        expiresAt: time,
        participants: z.array(ciParticipantSchema).min(1).max(128),
      })
      .nullable(),
  })
  .refine(
    (v) =>
      Buffer.byteLength(JSON.stringify(v)) <= 32000 &&
      (v.snapshot === null
        ? v.lastObservedAt === null
        : JSON.stringify(v.snapshot.target) === JSON.stringify(v.target) &&
          v.lastObservedAt === v.snapshot.observedAt) &&
      (v.claim === null ||
        (v.claim.expiresAt > v.claim.startedAt &&
          new Set(v.claim.participants.map((p) => p.id)).size === v.claim.participants.length)),
  );
export const ciViewSchema = z
  .strictObject({ record: ciRecordSchema, observation: ciTargetSchema })
  .refine(
    (v) =>
      v.record.targetId === v.observation.id &&
      JSON.stringify(v.record.binding.target) === JSON.stringify(v.observation.target),
  );
export const ciReadRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
});
export const ciControlRequestSchema = ciReadRequestSchema
  .extend({
    expectedRevision: time,
    action: z.enum(['suspend', 'cancel', 'complete', 'resume']),
    timeoutMs: timeout.optional(),
  })
  .refine((v) => v.action === 'resume' || v.timeoutMs === undefined);
export const ciListRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: stateIdSchema,
  after: z.union([z.literal(''), stateIdSchema]).default(''),
  limit: z.number().int().min(1).max(100).default(20),
});
export const ciListSchema = z.strictObject({
  items: z.array(ciRecordSchema).max(100),
  nextCursor: stateIdSchema.nullable(),
});
export const ciTickRequestSchema = z.strictObject({ schemaVersion: z.literal(1) });
export const ciTickSchema = z.strictObject({
  observed: z.number().int().min(0).max(32),
  deferred: z.number().int().min(0).max(32),
});
export const ciReadResultSchema = createOperationResultSchema(ciViewSchema.nullable());
export const ciWriteResultSchema = createStateWriteResultSchema(ciViewSchema);
export const ciListResultSchema = createOperationResultSchema(ciListSchema);
export const ciTickResultSchema = z.union([
  createOperationResultSchema(ciTickSchema),
  stateUncertainResultSchema,
]);
export type CiPolicy = z.infer<typeof ciPolicySchema>;
export type CiSource = z.infer<typeof ciSourceSchema>;
export type CiBinding = z.infer<typeof ciBindingSchema>;
export type CiRecord = z.infer<typeof ciRecordSchema>;
export type CiTarget = z.infer<typeof ciTargetSchema>;
export type CiView = z.infer<typeof ciViewSchema>;

export const ciWakeResultSchema = createOperationResultSchema(
  z.strictObject({ scheduled: z.literal(true) }),
);
