import { z } from 'zod';
import { configurationRequestSchema, configurationDigestSchema } from './configuration.js';
import { worktreePrepareRequestSchema } from './worktrees.js';
import { stateIdSchema } from './state.js';
import { workerInputTextSchema } from './worker-input.js';

export const instructionPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !value.includes('\0') &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git') &&
      value.endsWith('.md') &&
      !/[\r\n]/u.test(value),
  );
export const implementationSubmitRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: configurationRequestSchema.shape.projectId,
    checkoutId: configurationRequestSchema.shape.checkoutId.unwrap(),
    key: stateIdSchema,
    branch: worktreePrepareRequestSchema.shape.branch,
    commit: worktreePrepareRequestSchema.shape.baseCommit,
    description: workerInputTextSchema.refine((value) => Buffer.byteLength(value) <= 6000),
    acceptanceCriteria: z
      .array(workerInputTextSchema.refine((value) => Buffer.byteLength(value) <= 512))
      .max(16)
      .default([]),
    instructionPaths: z
      .array(instructionPathSchema)
      .max(8)
      .default(['AGENTS.md', 'AGENTS.override.md']),
    request: configurationRequestSchema.shape.request,
  })
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value)) <= 9000 &&
      new Set(value.instructionPaths).size === value.instructionPaths.length,
  );
export const instructionReferenceSchema = z.strictObject({
  path: instructionPathSchema,
  digest: configurationDigestSchema.nullable(),
});
export const implementationTaskSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    workflow: z.literal('implementation'),
    submission: implementationSubmitRequestSchema,
    worktreeId: stateIdSchema,
    root: z.string().min(1).max(4096),
    instructions: z.array(instructionReferenceSchema).max(8),
    resultContractVersion: z.literal(1),
  })
  .refine(
    (value) =>
      value.instructions.length === value.submission.instructionPaths.length &&
      value.instructions.every(
        (item, index) => item.path === value.submission.instructionPaths[index],
      ) &&
      Buffer.byteLength(JSON.stringify(value)) <= 14_000,
  );
export const implementationReadRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
});
export const implementationWorkerReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  attemptId: stateIdSchema,
  projectId: configurationRequestSchema.shape.projectId,
  checkoutId: configurationRequestSchema.shape.checkoutId.unwrap(),
  branch: worktreePrepareRequestSchema.shape.branch,
  baseCommit: worktreePrepareRequestSchema.shape.baseCommit,
  headCommit: worktreePrepareRequestSchema.shape.baseCommit,
  outcome: z.enum(['completed', 'needs_decision', 'failed']),
  summary: workerInputTextSchema.refine((value) => Buffer.byteLength(value) <= 4000),
  blockers: z
    .array(workerInputTextSchema.refine((value) => Buffer.byteLength(value) <= 512))
    .max(16),
});
export const implementationInputReceiptSchema = z.strictObject({
  key: stateIdSchema,
  digest: configurationDigestSchema,
  state: z.enum(['pending', 'acknowledged']),
});
export const implementationInputObservationSchema = z.strictObject({
  receipt: implementationInputReceiptSchema.nullable(),
  blocker: z
    .enum(['needs_decision', 'busy', 'policy_blocked', 'identity_changed', 'provider_unavailable'])
    .nullable(),
});
export const implementationProgressSchema = z.strictObject({
  state: z.enum([
    'queued',
    'starting',
    'started',
    'needs_decision',
    'blocked',
    'failed',
    'unknown',
    'awaiting_result',
  ]),
  delivery: z.enum(['not_submitted', 'pending', 'acknowledged']),
  reason: z.string().min(1).max(128).nullable(),
  acceptedOutcome: z.null(),
});
export type ImplementationSubmitRequest = z.infer<typeof implementationSubmitRequestSchema>;
export type InstructionReference = z.infer<typeof instructionReferenceSchema>;
export type ImplementationTask = z.infer<typeof implementationTaskSchema>;
export type ImplementationWorkerReport = z.infer<typeof implementationWorkerReportSchema>;
export type ImplementationInputReceipt = z.infer<typeof implementationInputReceiptSchema>;
export type ImplementationInputObservation = z.infer<typeof implementationInputObservationSchema>;
export type ImplementationProgress = z.infer<typeof implementationProgressSchema>;
