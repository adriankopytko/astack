import { z } from 'zod';
import { stateIdSchema, createStateWriteResultSchema } from './state.js';
import { handoffSourceSchema } from './handoff.js';
import { checkoutLocationSchema } from './projects.js';
import { artifactReferenceSchema } from './runs.js';
import { configurationDigestSchema } from './configuration.js';
import { createOperationResultSchema } from './operation-result.js';
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const verificationRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    jobId: stateIdSchema,
    reportId: stateIdSchema,
    key: stateIdSchema,
    allocations: z
      .array(z.strictObject({ id: stateIdSchema, expectedRevision: time }))
      .max(16)
      .default([]),
    lane: name.nullable().default(null),
    additional: z.array(name).max(8).default([]),
    writersExcluded: z.literal(true),
  })
  .refine(
    (v) =>
      new Set(v.additional).size === v.additional.length &&
      new Set(v.allocations.map((a) => a.id)).size === v.allocations.length,
  );
export const verificationCheckSchema = z.strictObject({
  name,
  kind: z.enum(['baseline', 'lane', 'additional']),
  definitionDigest: configurationDigestSchema,
  commandDigest: configurationDigestSchema,
  hookKey: stateIdSchema,
  hookId: stateIdSchema.nullable(),
  hookRevision: time.nullable(),
  resultDigest: configurationDigestSchema.nullable(),
  outcome: z.enum(['not_run', 'passed', 'failed', 'cancelled', 'unknown']),
});
export const verificationRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    request: verificationRequestSchema,
    source: handoffSourceSchema,
    role: name,
    reportDigest: configurationDigestSchema,
    policyDigest: configurationDigestSchema,
    selectionDigest: configurationDigestSchema,
    location: checkoutLocationSchema,
    artifacts: z.array(artifactReferenceSchema).max(8),
    checks: z.array(verificationCheckSchema).min(1).max(8),
    maxAgeMs: z.number().int().min(1000).max(86_400_000),
    status: z.enum([
      'prepared',
      'running',
      'passed',
      'failed',
      'cancelled',
      'unknown',
      'invalidated',
    ]),
    revision: time,
    createdAt: time,
    updatedAt: time,
    verifiedAt: time.nullable(),
    expiresAt: time.nullable(),
    reason: z
      .enum([
        'check_failed',
        'cancelled',
        'execution_uncertain',
        'source_changed',
        'policy_changed',
        'writer_excluded',
      ])
      .nullable(),
    reconciliation: z
      .strictObject({ key: stateIdSchema, expectedRevision: time, writersStopped: z.literal(true) })
      .nullable(),
  })
  .refine(
    (v) =>
      (v.status === 'passed') === (v.verifiedAt !== null && v.expiresAt !== null) &&
      (v.status !== 'passed' || v.checks.every((c) => c.outcome === 'passed')) &&
      new Set(v.checks.map((c) => c.name)).size === v.checks.length &&
      Buffer.byteLength(JSON.stringify(v)) <= 32768,
  );
export const verificationSelectorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
});
export const verificationReconcileSchema = verificationSelectorSchema.extend({
  expectedRevision: time,
  key: stateIdSchema,
  writersStopped: z.literal(true),
});
export const verificationReadResultSchema = createOperationResultSchema(
  verificationRecordSchema.nullable(),
);
export const verificationWriteResultSchema = createStateWriteResultSchema(verificationRecordSchema);
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;
export type VerificationRecord = z.infer<typeof verificationRecordSchema>;
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationReconcile = z.infer<typeof verificationReconcileSchema>;

export const verificationAuthorizationSchema = verificationSelectorSchema.extend({
  source: handoffSourceSchema,
  jobId: stateIdSchema,
  reportId: stateIdSchema,
});
