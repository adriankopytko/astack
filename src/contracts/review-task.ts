import { z } from 'zod';
import {
  implementationSubmitRequestSchema,
  instructionReferenceSchema,
  implementationProgressSchema,
} from './implementation-task.js';
import { stateIdSchema } from './state.js';

export const reviewTargetSchema = z.strictObject({
  host: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/)
    .refine((v) => !v.includes('..')),
  repository: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/),
  number: z.number().int().positive().max(2147483647),
  sha: implementationSubmitRequestSchema.shape.commit,
});
const checkName = z
  .string()
  .min(1)
  .max(128)
  .refine((v) =>
    Array.from(v).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
export const reviewGatePolicySchema = z
  .strictObject({
    requiredChecks: z.array(checkName).max(32).default([]),
    allowNoChecks: z.boolean().optional(),
    overrideReason: z
      .string()
      .min(1)
      .max(512)
      .refine((v) =>
        Array.from(v).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
      )
      .nullable()
      .default(null),
  })
  .refine((v) => new Set(v.requiredChecks).size === v.requiredChecks.length);
export const reviewCheckSchema = z.strictObject({
  name: checkName,
  state: z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']),
});
export const reviewSnapshotSchema = z
  .strictObject({
    target: reviewTargetSchema,
    baseSha: implementationSubmitRequestSchema.shape.commit,
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    draft: z.boolean(),
    // Attribution only, never an executable URL or authority to fetch.
    sourceRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable(),
    checks: z.array(reviewCheckSchema).max(64),
    observedAt: z.number().int().nonnegative(),
  })
  .refine((v) => new Set(v.checks.map((c) => c.name)).size === v.checks.length);
export const reviewSubmitRequestSchema = z
  .strictObject(implementationSubmitRequestSchema.shape)
  .omit({ description: true, acceptanceCriteria: true })
  .extend({
    target: reviewTargetSchema,
    gate: reviewGatePolicySchema.default({ requiredChecks: [], overrideReason: null }),
    repeat: z.boolean().default(false),
    resources: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
      .max(16)
      .default([]),
  })
  .refine(
    (v) =>
      v.commit === v.target.sha &&
      new Set(v.instructionPaths).size === v.instructionPaths.length &&
      Buffer.byteLength(JSON.stringify(v)) <= 6000,
  );
export const reviewTaskSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    workflow: z.literal('review'),
    submission: reviewSubmitRequestSchema,
    authorization: z.literal('manual-request'),
    worktreeId: stateIdSchema,
    root: z.string().min(1).max(4096),
    instructions: z.array(instructionReferenceSchema).max(8),
    initialSnapshot: reviewSnapshotSchema,
    resultContractVersion: z.literal(1),
    promptVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })
  .refine(
    (v) =>
      JSON.stringify(v.submission.target) === JSON.stringify(v.initialSnapshot.target) &&
      v.instructions.length === v.submission.instructionPaths.length &&
      v.instructions.every((x, i) => x.path === v.submission.instructionPaths[i]) &&
      Buffer.byteLength(JSON.stringify(v)) <= 14000,
  );
export const reviewReadRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
});
export const reviewProgressSchema = implementationProgressSchema;
export type ReviewTarget = z.infer<typeof reviewTargetSchema>;
export type ReviewGatePolicy = z.infer<typeof reviewGatePolicySchema>;
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
export type ReviewSubmitRequest = z.infer<typeof reviewSubmitRequestSchema>;
export type ReviewTask = z.infer<typeof reviewTaskSchema>;

const reportText = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v) <= 4000);
export const reviewWorkerReportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    jobId: stateIdSchema,
    attemptId: stateIdSchema,
    projectId: reviewSubmitRequestSchema.shape.projectId,
    checkoutId: reviewSubmitRequestSchema.shape.checkoutId,
    target: reviewTargetSchema,
    outcome: z.enum(['reviewed', 'needs_decision', 'failed']),
    summary: reportText,
    findings: z
      .array(
        z.strictObject({
          severity: z.enum(['critical', 'high', 'medium', 'low']),
          path: z
            .string()
            .min(1)
            .max(512)
            .refine(
              (v) =>
                !v.startsWith('/') &&
                !v.includes('\\') &&
                v.split('/').every((part) => part !== '..' && part !== '.' && part !== ''),
            ),
          line: z.number().int().positive(),
          description: reportText.refine((v) => Buffer.byteLength(v) <= 1000),
        }),
      )
      .max(32),
    blockers: z.array(reportText.refine((v) => Buffer.byteLength(v) <= 512)).max(16),
    gate: reviewGatePolicySchema,
    acceptanceSnapshot: reviewSnapshotSchema,
    currentSnapshot: reviewSnapshotSchema.nullable(),
  })
  .refine((v) =>
    [v.acceptanceSnapshot, v.currentSnapshot].every(
      (snapshot) =>
        snapshot === null ||
        (snapshot.target.host === v.target.host &&
          snapshot.target.repository === v.target.repository &&
          snapshot.target.number === v.target.number &&
          snapshot.target.sha === v.target.sha),
    ),
  );
export type ReviewWorkerReport = z.infer<typeof reviewWorkerReportSchema>;
