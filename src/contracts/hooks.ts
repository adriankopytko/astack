import { z } from 'zod';
import { stateIdSchema, createStateWriteResultSchema } from './state.js';
import { configurationDigestSchema } from './configuration.js';
import { checkoutLocationSchema } from './projects.js';
import { allocationBindingSchema } from './resources.js';
import { processExecutionSchema } from './process.js';
import { createOperationResultSchema, rejectedResultSchema } from './operation-result.js';
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hookPhaseSchema = z.enum(['setup', 'verify', 'start', 'teardown']);
export const hookRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    jobId: stateIdSchema,
    attemptId: stateIdSchema,
    key: stateIdSchema,
    phase: hookPhaseSchema,
    commit: allocationBindingSchema.shape.commit,
    allocations: z
      .array(z.strictObject({ id: stateIdSchema, expectedRevision: time }))
      .max(16)
      .default([]),
    writersExcluded: z.literal(true),
  })
  .refine((v) => new Set(v.allocations.map((a) => a.id)).size === v.allocations.length);
export const hookProcessEvidenceSchema = z.strictObject({
  outcome: processExecutionSchema.shape.outcome,
  exitCode: processExecutionSchema.shape.exitCode,
  signal: processExecutionSchema.shape.signal,
  shutdown: processExecutionSchema.shape.shutdown,
  stdout: z.strictObject({
    observedBytes: processExecutionSchema.shape.stdout.shape.observedBytes,
    complete: z.boolean(),
  }),
  stderr: z.strictObject({
    observedBytes: processExecutionSchema.shape.stderr.shape.observedBytes,
    complete: z.boolean(),
  }),
});
export const hookRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    request: hookRequestSchema,
    binding: allocationBindingSchema,
    worktreeId: stateIdSchema,
    root: checkoutLocationSchema.shape.root.shape.path,
    location: checkoutLocationSchema,
    policyDigest: configurationDigestSchema,
    commandDigest: configurationDigestSchema,
    command: z.string().min(1).max(64),
    timeoutMs: z.number().int().min(10).max(86_400_000),
    environmentNames: z.array(z.string().max(128)).max(64),
    status: z.enum(['prepared', 'executing', 'succeeded', 'failed', 'cancelled', 'unknown']),
    revision: time,
    createdAt: time,
    updatedAt: time,
    endpoints: z
      .array(
        z.strictObject({
          id: stateIdSchema,
          observation: z.enum(['free', 'busy', 'unknown', 'not_probed']),
        }),
      )
      .max(16),
    result: hookProcessEvidenceSchema.nullable(),
    reason: z
      .enum([
        'process_failed',
        'process_uncertain',
        'target_changed',
        'prerequisites_changed',
        'cancelled',
      ])
      .nullable(),
    writerExclusion: z
      .strictObject({ key: stateIdSchema, expectedRevision: time, writersStopped: z.literal(true) })
      .nullable(),
    shutdown: z
      .strictObject({
        key: stateIdSchema,
        expectedRevision: time,
        writersStopped: z.literal(true),
        servicesStopped: z.literal(true),
      })
      .nullable(),
  })
  .refine((record) => {
    const result = record.result;
    const completed =
      result?.outcome === 'exited' &&
      result.exitCode === 0 &&
      result.shutdown.root === 'exited' &&
      result.shutdown.processGroup === 'absent' &&
      result.stdout.complete &&
      result.stderr.complete;

    return (
      Buffer.byteLength(JSON.stringify(record)) <= 32768 &&
      record.root === record.location.root.path &&
      record.binding.commit === record.request.commit &&
      record.createdAt <= record.updatedAt &&
      new Set(record.environmentNames).size === record.environmentNames.length &&
      record.environmentNames.every((name) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) &&
      (record.status !== 'succeeded' || completed) &&
      (!['prepared', 'executing'].includes(record.status) ||
        (result === null && record.reason === null)) &&
      record.endpoints.every((endpoint) =>
        record.request.allocations.some((ref) => ref.id === endpoint.id),
      )
    );
  });

export const hookSelectorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
});
export const hookReconcileSchema = hookSelectorSchema.extend({
  expectedRevision: time,
  key: stateIdSchema,
  writersStopped: z.literal(true),
  servicesStopped: z.literal(true),
});
export const hookReadResultSchema = createOperationResultSchema(hookRecordSchema.nullable());
export const hookWriteResultSchema = createStateWriteResultSchema(hookRecordSchema);
export const hookExecutionResultSchema = z.union([
  hookWriteResultSchema,
  rejectedResultSchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('skipped'),
    reason: z.literal('static_review'),
  }),
]);
export type HookRequest = z.infer<typeof hookRequestSchema>;
export type HookRecord = z.infer<typeof hookRecordSchema>;
export type HookReconcile = z.infer<typeof hookReconcileSchema>;
export type HookProcessEvidence = z.infer<typeof hookProcessEvidenceSchema>;

export const hookExcludeSchema = hookSelectorSchema.extend({
  expectedRevision: time,
  key: stateIdSchema,
  writersStopped: z.literal(true),
});
export type HookExclude = z.infer<typeof hookExcludeSchema>;
