import { isAbsolute } from 'node:path';
import { reviewFixReferenceSchema } from './implementation-task.js';
import { z } from 'zod';
import { stateIdSchema, stateEffectSchema, createStateWriteResultSchema } from './state.js';
import { acceptedRunReportSchema } from './runs.js';
import { reviewTaskSchema, reviewTargetSchema } from './review-task.js';
import { githubPublicationSchema } from './github.js';
import { createOperationResultSchema } from './operation-result.js';

export const reviewResultReadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  reportKey: stateIdSchema,
});
export const reviewResultObservationSchema = z.strictObject({
  reportId: stateIdSchema,
  revision: z.number().int().nonnegative(),
  state: z.enum(['current', 'stale', 'unavailable']),
  reason: z.string().min(1).max(128).nullable(),
  observedAt: z.number().int().nonnegative(),
});
export const reviewResultViewSchema = z.strictObject({
  report: acceptedRunReportSchema,
  assignment: reviewTaskSchema,
  observation: reviewResultObservationSchema.nullable(),
  freshness: z.enum(['not_checked', 'current', 'stale', 'unavailable']),
  fixReference: z.strictObject(reviewFixReferenceSchema.shape).omit({ findingIndexes: true }),
});
export const reviewResultPublishSchema = reviewResultReadSchema
  .extend({
    reportId: stateIdSchema,
    key: stateIdSchema,
    actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?$/),
    kind: z.enum(['review', 'comment']).default('review'),
    event: z.enum(['COMMENT', 'REQUEST_CHANGES']).default('COMMENT'),
    findingIndexes: z.array(z.number().int().min(0).max(31)).max(32).optional(),
  })
  .refine(
    (v) =>
      new Set(v.findingIndexes).size === (v.findingIndexes?.length ?? 0) &&
      (v.kind === 'review' || v.event === 'COMMENT'),
  );
export const reviewResultExecuteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  request: reviewResultPublishSchema,
  writersStopped: z.literal(true),
});
export const reviewResultPublicationReadSchema = reviewResultReadSchema.extend({
  key: stateIdSchema,
});
export const reviewResultReconcileSchema = reviewResultPublicationReadSchema.extend({
  writersStopped: z.literal(true),
});
export const reviewResultPublicationSchema = z.strictObject({
  id: stateIdSchema,
  request: reviewResultPublishSchema,
  projectId: stateIdSchema,
  repositoryId: stateIdSchema,
  checkoutId: stateIdSchema,
  sourceAttemptId: stateIdSchema,
  reportDigest: z.string().regex(/^[0-9a-f]{64}$/),
  root: z.string().min(1).max(4096).refine(isAbsolute),
  branch: z.string().min(1),
  target: reviewTargetSchema,
  publicationJobId: stateIdSchema,
  publicationAttemptId: stateIdSchema,
  effectId: stateIdSchema,
  publication: githubPublicationSchema,
  createdAt: z.number().int().nonnegative(),
});
export const reviewResultPublicationViewSchema = z.strictObject({
  record: reviewResultPublicationSchema,
  effect: stateEffectSchema,
});
export const reviewResultReadResultSchema = createOperationResultSchema(reviewResultViewSchema);
export const reviewResultObservationResultSchema = createStateWriteResultSchema(
  reviewResultObservationSchema,
);
export const reviewResultPublicationReadResultSchema = createOperationResultSchema(
  reviewResultPublicationViewSchema.nullable(),
);
export const reviewResultPublicationWriteResultSchema = createStateWriteResultSchema(
  reviewResultPublicationViewSchema,
);
export type ReviewResultRead = z.infer<typeof reviewResultReadSchema>;
export type ReviewResultView = z.infer<typeof reviewResultViewSchema>;
export type ReviewResultObservation = z.infer<typeof reviewResultObservationSchema>;
export type ReviewResultPublish = z.infer<typeof reviewResultPublishSchema>;
export type ReviewResultPublication = z.infer<typeof reviewResultPublicationSchema>;
export type ReviewResultPublicationView = z.infer<typeof reviewResultPublicationViewSchema>;
