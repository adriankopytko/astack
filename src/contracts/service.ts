import { z } from 'zod';
import { configurationRequestSchema } from './configuration.js';
import { worktreePrepareRequestSchema } from './worktrees.js';
import {
  stateJobSchema,
  stateAttemptSchema,
  stateEffectSchema,
  stateClaimSchema,
  stateIdSchema,
  createStateWriteResultSchema,
} from './state.js';
import { createOperationResultSchema, operationErrorSchema } from './operation-result.js';

const metadata = stateEffectSchema.shape.intent.shape.payload;
export const serviceLimitsSchema = z.strictObject({
  global: z.number().int().min(1).max(64).default(1),
  perRole: z
    .record(configurationRequestSchema.shape.role, z.number().int().min(1).max(64))
    .default({}),
  defaultRole: z.number().int().min(1).max(64).default(1),
});
export const serviceSubmitRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: configurationRequestSchema.shape.projectId,
  checkoutId: configurationRequestSchema.shape.checkoutId,
  role: configurationRequestSchema.shape.role,
  request: configurationRequestSchema.shape.request,
  key: stateIdSchema,
  branch: worktreePrepareRequestSchema.shape.branch,
  commit: stateAttemptSchema.shape.commit,
  task: metadata,
});
export const workerObservationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('running'), handle: metadata, evidence: metadata }),
  z.strictObject({ state: z.literal('quiescent'), handle: metadata, evidence: metadata }),
  z.strictObject({ state: z.literal('not_started'), handle: z.null(), evidence: metadata }),
  z.strictObject({ state: z.literal('unknown'), handle: metadata.nullable(), evidence: metadata }),
]);
export const serviceEntrySchema = z
  .strictObject({
    jobId: stateIdSchema,
    attemptId: stateIdSchema,
    effectId: stateIdSchema,
    role: configurationRequestSchema.shape.role,
    branch: serviceSubmitRequestSchema.shape.branch,
    commit: stateAttemptSchema.shape.commit,
    state: z.enum(['queued', 'dispatching', 'started', 'awaiting_result', 'blocked', 'unknown']),
    reason: z
      .enum([
        'configuration_blocked',
        'runtime_unavailable',
        'assignment_changed',
        'provider_uncertain',
        'provider_refused',
        'recovery_required',
      ])
      .nullable(),
    claim: stateClaimSchema.nullable(),
    observation: workerObservationSchema.nullable(),
  })
  .refine((value) => {
    try {
      return JSON.stringify(value).length <= 32_768;
    } catch {
      return false;
    }
  })
  .refine((value) => {
    switch (value.state) {
      case 'queued':
        return value.claim === null && value.observation === null && value.reason === null;
      case 'dispatching':
        return value.claim !== null && value.observation === null && value.reason === null;
      case 'started':
        return (
          value.claim !== null && value.observation?.state === 'running' && value.reason === null
        );
      case 'awaiting_result':
        return (
          value.claim !== null && value.observation?.state === 'quiescent' && value.reason === null
        );
      case 'unknown':
        return (
          value.claim !== null && value.observation?.state === 'unknown' && value.reason !== null
        );
      case 'blocked':
        return (
          value.reason !== null &&
          (value.claim === null
            ? value.observation === null
            : value.observation?.state === 'not_started' && value.reason === 'provider_refused')
        );
    }
  });
export const serviceJobSchema = z
  .strictObject({
    job: stateJobSchema,
    entry: serviceEntrySchema,
    attempt: stateAttemptSchema,
    effect: stateEffectSchema,
  })
  .refine(
    (value) =>
      value.entry.jobId === value.job.id &&
      value.attempt.jobId === value.job.id &&
      value.entry.attemptId === value.attempt.id &&
      value.entry.effectId === value.effect.intent.id &&
      value.effect.intent.attemptId === value.attempt.id &&
      value.entry.branch === value.attempt.branch &&
      value.entry.commit === value.attempt.commit &&
      value.entry.role === value.job.configuration?.role,
  );
export const serviceStatusSchema = z.strictObject({
  sessionId: stateIdSchema,
  phase: z.enum(['recovering', 'running', 'stopping']),
  limits: serviceLimitsSchema,
  runtimes: z.array(z.string()),
  counts: z.record(serviceEntrySchema.shape.state, z.number().int().nonnegative()),
});
export const serviceReadRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
});
export const serviceRpcRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('status') }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('wake') }),
  serviceSubmitRequestSchema.extend({ operation: z.literal('submit') }),
  serviceReadRequestSchema.extend({ operation: z.literal('inspect') }),
]);
export const serviceRpcResponseSchema = z.union([
  createOperationResultSchema(serviceStatusSchema),
  createOperationResultSchema(serviceJobSchema.nullable()),
  createStateWriteResultSchema(serviceJobSchema),
]);
export const serviceRunRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stateDirectory: z.string().optional(),
  gitExecutable: z.string().optional(),
  limits: serviceLimitsSchema.default({ global: 1, perRole: {}, defaultRole: 1 }),
});
export type ServiceSubmitRequest = z.infer<typeof serviceSubmitRequestSchema>;
export type WorkerObservation = z.infer<typeof workerObservationSchema>;
export type ServiceEntry = z.infer<typeof serviceEntrySchema>;
export type ServiceJob = z.infer<typeof serviceJobSchema>;
export type ServiceLimits = z.infer<typeof serviceLimitsSchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ServiceRpcRequest = z.infer<typeof serviceRpcRequestSchema>;
export type ServiceRpcResponse = z.infer<typeof serviceRpcResponseSchema>;
export type ServiceFailure = z.infer<typeof operationErrorSchema>;
