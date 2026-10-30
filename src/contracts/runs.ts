import { runReconciliationSchema } from './run-reconciliation.js';
import { z } from 'zod';
import { stateIdSchema, stateEffectIntentSchema, createStateWriteResultSchema } from './state.js';
import { serviceJobSchema } from './service.js';
import { runControlSchema } from './run-control.js';
import { implementationWorkerReportSchema } from './implementation-task.js';
import { reviewWorkerReportSchema, reviewSnapshotSchema } from './review-task.js';
import { workerInputTextSchema } from './worker-input.js';
import { createOperationResultSchema } from './operation-result.js';
export * from './run-control.js';
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = workerInputTextSchema.refine((v) => Buffer.byteLength(v) <= 4096);
export const artifactReferenceSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (v) =>
        !v.startsWith('/') &&
        !v.includes('\\') &&
        !v.includes('\0') &&
        v.split('/').every((p) => p !== '' && p !== '.' && p !== '..' && p !== '.git'),
    ),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  size: offset.max(4 * 1024 * 1024),
});
export const runReadRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
});
export const runReportRequestSchema = runReadRequestSchema
  .extend({
    key: stateIdSchema,
    proposal: z.union([implementationWorkerReportSchema, reviewWorkerReportSchema]),
    acceptHistoricalReview: z.literal(true).optional(),
    artifacts: z.array(artifactReferenceSchema).max(8).default([]),
  })
  .refine(
    (v) =>
      Buffer.byteLength(JSON.stringify(v)) <= 48000 &&
      new Set(v.artifacts.map((a) => a.path)).size === v.artifacts.length,
  );
export const acceptedRunReportMaxBytes = 96 * 1024;
export const acceptedRunReportSchema = z
  .strictObject({
    id: stateIdSchema,
    jobId: stateIdSchema,
    attemptId: stateIdSchema,
    key: stateIdSchema,
    request: runReportRequestSchema,
    validatedAt: offset,
    evidence: z.strictObject({
      commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
      reviewSnapshot: reviewSnapshotSchema.nullable(),
      historicalReview: z.literal(true).optional(),
    }),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= acceptedRunReportMaxBytes);
export const runResponseRequestSchema = runReadRequestSchema.extend({
  key: stateIdSchema,
  decisionId: stateIdSchema,
  text,
});
export const runResponseSchema = runResponseRequestSchema.extend({
  id: stateIdSchema,
  attemptId: stateIdSchema,
  createdAt: offset,
});
export const runResumeRequestSchema = runReadRequestSchema.extend({
  key: stateIdSchema,
  responseId: stateIdSchema,
});
export const runResumeSchema = runResumeRequestSchema.extend({
  id: stateIdSchema,
  attemptId: stateIdSchema,
  actionKey: stateIdSchema,
  state: z.enum(['authorized', 'pending', 'acknowledged', 'blocked', 'unknown']),
  reason: z.string().max(128).nullable(),
  createdAt: offset,
});
export const runCancelRequestSchema = runReadRequestSchema.extend({
  key: stateIdSchema,
  interrupt: z.boolean().default(false),
});
export const runCancellationSchema = runCancelRequestSchema.extend({
  attemptId: stateIdSchema,
  createdAt: offset,
  interruptState: z.enum([
    'not_requested',
    'not_needed',
    'requested',
    'acknowledged',
    'blocked',
    'unknown',
  ]),
});
export const runViewSchema = z.strictObject({
  status: z.enum([
    'queued',
    'starting',
    'started',
    'blocked',
    'unknown',
    'awaiting_result',
    'needs_decision',
    'completed',
    'failed',
    'cancel_requested',
    'cancelled',
  ]),
  job: serviceJobSchema,
  control: runControlSchema,
  report: acceptedRunReportSchema.nullable(),
  responses: z.array(runResponseSchema).max(10),
  resumes: z.array(runResumeSchema).max(10),
  cancellation: runCancellationSchema.nullable(),
  cleanup: z.strictObject({
    state: z.enum(['retained', 'reconciled']),
    reconciliation: runReconciliationSchema.nullable(),
    checkoutId: stateIdSchema,
    resourceCount: offset,
    retainedResourceCount: offset,
    resources: z
      .array(
        z.strictObject({ id: stateIdSchema, kind: stateIdSchema, releasedAt: offset.nullable() }),
      )
      .max(100),
  }),
});
export const runEventSchema = z.strictObject({
  id: offset,
  projectId: stateIdSchema,
  jobId: stateIdSchema,
  attemptId: stateIdSchema,
  kind: z.enum([
    'accepted',
    'baseline',
    'claimed',
    'blocked',
    'observed',
    'report_accepted',
    'response_recorded',
    'resume_authorized',
    'resume_observed',
    'cancel_requested',
    'cancel_observed',
    'cancelled',
    'lifecycle_reconciled',
    'handoff_prepared',
    'handoff_accepted',
    'ci_requested',
    'ci_controlled',
    'ci_observed',
    'follow_up_queued',
    'follow_up_controlled',
    'follow_up_dispatched',
    'handoff_abandoned',
    'review_result_observed',
    'review_publication_prepared',
    'review_fix_accepted',
    'publication_finalized',
    'cleanup_changed',
    'allocation_changed',
    'hook_changed',
    'verification_changed',
  ]),
  createdAt: offset,
  detail: stateEffectIntentSchema.shape.payload,
});
export const runEventScopeSchema = z.strictObject({
  projectId: stateIdSchema.optional(),
  jobId: stateIdSchema.optional(),
});
export const runEventsRequestSchema = runEventScopeSchema.extend({
  schemaVersion: z.literal(1),
  after: offset.default(0),
  limit: z.number().int().min(1).max(100).default(50),
  waitMs: z.number().int().min(0).max(20000).default(0),
});
export const runEventPageSchema = z.strictObject({
  events: z.array(runEventSchema).max(100),
  nextCursor: offset,
  highWatermark: offset,
});
export const runCursorReadRequestSchema = runEventScopeSchema.extend({
  schemaVersion: z.literal(1),
  consumer: stateIdSchema,
});
export const runCursorRequestSchema = runCursorReadRequestSchema.extend({
  expected: offset,
  after: offset,
});
export const runCursorSchema = runCursorReadRequestSchema.extend({ after: offset });
export const runReadResultSchema = createOperationResultSchema(runViewSchema.nullable());
export const runWriteResultSchema = createStateWriteResultSchema(runViewSchema);
export const runEventsResultSchema = createOperationResultSchema(runEventPageSchema);
export const runCursorResultSchema = createOperationResultSchema(runCursorSchema);
export const runCursorWriteResultSchema = createStateWriteResultSchema(runCursorSchema);
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type RunReportRequest = z.infer<typeof runReportRequestSchema>;
export type AcceptedRunReport = z.infer<typeof acceptedRunReportSchema>;
export type RunView = z.infer<typeof runViewSchema>;
export type RunResponse = z.infer<typeof runResponseSchema>;
export type RunResponseRequest = z.infer<typeof runResponseRequestSchema>;
export type RunResume = z.infer<typeof runResumeSchema>;
export type RunResumeRequest = z.infer<typeof runResumeRequestSchema>;
export type RunCancellation = z.infer<typeof runCancellationSchema>;
export type RunCancelRequest = z.infer<typeof runCancelRequestSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventScope = z.infer<typeof runEventScopeSchema>;
export type RunEventsRequest = z.infer<typeof runEventsRequestSchema>;
export type RunEventPage = z.infer<typeof runEventPageSchema>;
export type RunCursor = z.infer<typeof runCursorSchema>;
export type RunCursorRequest = z.infer<typeof runCursorRequestSchema>;
