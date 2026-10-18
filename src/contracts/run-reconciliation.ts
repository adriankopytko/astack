import { z } from 'zod';
import { stateIdSchema, stateEffectIntentSchema } from './state.js';

const metadata = stateEffectIntentSchema.shape.payload;
export const runReconcileRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  key: stateIdSchema,
  attemptId: stateIdSchema,
  launchId: stateIdSchema,
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  workerStopped: z.literal(true),
  servicesStopped: z.literal(true),
  writersStopped: z.literal(true),
});
export const runReconciliationSchema = z
  .strictObject({
    request: runReconcileRequestSchema,
    source: z.literal('host-attestation'),
    workerHandle: metadata,
    resourceBindings: z
      .array(
        z.strictObject({
          id: stateIdSchema,
          kind: stateIdSchema,
          key: stateIdSchema,
          handle: metadata,
        }),
      )
      .min(1)
      .max(16),
    verifiedAt: z.number().int().nonnegative(),
    providerEvidence: metadata,
    releasedResourceIds: z.array(stateIdSchema).max(16),
  })
  .refine(
    (record) =>
      new Set(record.resourceBindings.map((binding) => binding.id)).size ===
      record.resourceBindings.length,
  );
export type RunReconcileRequest = z.infer<typeof runReconcileRequestSchema>;
export type RunReconciliation = z.infer<typeof runReconciliationSchema>;
