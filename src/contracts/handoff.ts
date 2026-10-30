import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  githubPublicationSchema,
  githubPublicationReceiptSchema,
  githubRepositorySchema,
  githubBranchSchema,
} from './github.js';
import { artifactReferenceSchema } from './runs.js';
import { stateIdSchema, stateEffectSchema, createStateWriteResultSchema } from './state.js';
import { reviewGatePolicySchema, reviewTargetSchema } from './review-task.js';
import { instructionPathSchema } from './implementation-task.js';
import { createOperationResultSchema } from './operation-result.js';

export const pullRequestPublicationSchema = githubPublicationSchema.options[0];
export const pushIntentSchema = z.strictObject({
  repository: githubRepositorySchema,
  branch: githubBranchSchema,
  sha: reviewTargetSchema.shape.sha,
  expectedHead: reviewTargetSchema.shape.sha.nullable(),
});
export const pushReceiptSchema = pushIntentSchema
  .omit({ expectedHead: true })
  .extend({ observedAt: z.number().int().nonnegative() });
export const handoffRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    jobId: stateIdSchema,
    reportId: stateIdSchema,
    key: stateIdSchema,
    publication: pullRequestPublicationSchema,
    expectedRemoteHead: reviewTargetSchema.shape.sha.nullable().default(null),
    verification: z.union([
      z
        .strictObject({
          source: z.literal('host-attestation'),
          checks: z
            .array(
              z.strictObject({
                name: z
                  .string()
                  .min(1)
                  .max(128)
                  .refine((v) => !v.includes('\0')),
                outcome: z.literal('passed'),
                artifact: artifactReferenceSchema.nullable(),
              }),
            )
            .min(1)
            .max(8),
        })
        .refine((v) => new Set(v.checks.map((c) => c.name)).size === v.checks.length),
      z.strictObject({ source: z.literal('executed'), id: stateIdSchema }),
    ]),
    review: z
      .strictObject({
        gate: reviewGatePolicySchema,
        instructionPaths: z.array(instructionPathSchema).max(8),
      })
      .refine((v) => new Set(v.instructionPaths).size === v.instructionPaths.length)
      .nullable()
      .default(null),
    replaces: stateIdSchema.nullable().default(null),
  })
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 16000);
export const handoffSourceSchema = z.strictObject({
  projectId: stateIdSchema,
  repositoryId: stateIdSchema,
  checkoutId: stateIdSchema,
  attemptId: stateIdSchema,
  worktreeId: stateIdSchema,
  root: z.string().min(1).max(4096).refine(isAbsolute),
  branch: z.string().startsWith('refs/heads/'),
  baseCommit: reviewTargetSchema.shape.sha,
  headCommit: reviewTargetSchema.shape.sha,
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const handoffRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    request: handoffRequestSchema,
    source: handoffSourceSchema,
    phase: z.enum(['prepared', 'accepted', 'abandoned']),
    publicationJobId: stateIdSchema,
    publicationAttemptId: stateIdSchema,
    pushEffectId: stateIdSchema,
    publicationEffectId: stateIdSchema,
    createdAt: z.number().int().nonnegative(),
    acceptedAt: z.number().int().nonnegative().nullable(),
    receipt: githubPublicationReceiptSchema.nullable(),
    followUpReview: z
      .strictObject({
        id: stateIdSchema,
        authorization: z.literal('explicit-handoff'),
        state: z.literal('requested'),
        sourceJobId: stateIdSchema,
        sourceReportId: stateIdSchema,
        target: reviewTargetSchema,
        gate: reviewGatePolicySchema,
        instructionPaths: z.array(instructionPathSchema).max(8),
      })
      .nullable(),
  })
  .refine(
    (v) =>
      (v.phase === 'accepted') === (v.acceptedAt !== null && v.receipt !== null) &&
      (v.phase !== 'accepted'
        ? v.acceptedAt === null && v.receipt === null && v.followUpReview === null
        : (v.request.review === null) === (v.followUpReview === null)) &&
      (v.receipt === null ||
        (v.receipt.kind === 'pull-request' &&
          v.receipt.target.host === v.request.publication.target.host &&
          v.receipt.target.repository === v.request.publication.target.repository &&
          v.receipt.target.sha === v.source.headCommit)) &&
      (v.followUpReview === null ||
        (v.followUpReview.sourceJobId === v.request.jobId &&
          v.followUpReview.sourceReportId === v.request.reportId &&
          v.followUpReview.target.number === v.receipt?.target.number &&
          v.followUpReview.target.sha === v.source.headCommit)) &&
      Buffer.byteLength(JSON.stringify(v)) +
        (v.phase === 'prepared' ? 2048 + Buffer.byteLength(JSON.stringify(v.request.review)) : 0) <=
        28000,
  );
export const handoffViewSchema = z.strictObject({
  record: handoffRecordSchema,
  push: stateEffectSchema,
  publication: stateEffectSchema,
});
export const handoffReadRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  key: stateIdSchema.optional(),
});
export const handoffExecuteRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  request: handoffRequestSchema,
  writersStopped: z.literal(true),
});
export const handoffReconcileRequestSchema = handoffReadRequestSchema.extend({
  writersStopped: z.literal(true),
});
export const handoffReadResultSchema = createOperationResultSchema(handoffViewSchema.nullable());
export const handoffWriteResultSchema = createStateWriteResultSchema(handoffViewSchema);
export type PushIntent = z.infer<typeof pushIntentSchema>;
export type PushReceipt = z.infer<typeof pushReceiptSchema>;
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;
export type HandoffSource = z.infer<typeof handoffSourceSchema>;
export type HandoffRecord = z.infer<typeof handoffRecordSchema>;
export type HandoffView = z.infer<typeof handoffViewSchema>;
