import { z } from 'zod';
import { workerInputTextSchema } from './worker-input.js';
import { stateIdSchema } from './state.js';
import { herdrSpaceSchema, herdrAgentSchema } from './herdr.js';
import { createOperationResultSchema } from './operation-result.js';

export const runtimeCapabilities = Object.freeze({
  runtime: 'codex-herdr' as const,
  executionOwner: 'herdr' as const,
  launch: true,
  inspect: true,
  input: true,
  interrupt: true,
  reconcile: true,
  headless: false,
  atomicTargetGuard: false,
  deliveryReceipts: false,
  verifiedQuiescence: false,
});
export const runtimeRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attemptId: stateIdSchema,
});
export const runtimeInputRequestSchema = runtimeRequestSchema.extend({
  key: stateIdSchema,
  text: workerInputTextSchema,
});
export const runtimeInterruptRequestSchema = runtimeRequestSchema.extend({ key: stateIdSchema });
export const runtimeInputRetryRequestSchema = runtimeInterruptRequestSchema.extend({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  generation: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  notSubmitted: z.literal(true),
  writerStopped: z.literal(true),
});
export const runtimeLaunchValidationSchema = z
  .strictObject({
    invocationId: stateIdSchema,
    profileDigest: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(['pending', 'validated']),
    contextDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    argumentsDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .refine((v) =>
    v.state === 'pending'
      ? v.contextDigest === null && v.argumentsDigest === null
      : v.contextDigest !== null && v.argumentsDigest !== null,
  );
export const runtimeSessionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runtime: z.literal('codex-herdr'),
    launchId: stateIdSchema,
    jobId: stateIdSchema,
    attemptId: stateIdSchema,
    effectId: stateIdSchema,
    space: herdrSpaceSchema,
    phase: z.enum(['pending', 'ready']),
    validation: runtimeLaunchValidationSchema.optional(),
    agent: herdrAgentSchema.nullable(),
  })
  .refine(
    (value) =>
      value.space.kind === 'worker' &&
      value.space.phase === 'ready' &&
      value.space.attemptId === value.attemptId &&
      value.space.handle !== null &&
      (value.phase !== 'ready' ||
        value.validation === undefined ||
        value.validation.state === 'validated') &&
      (value.phase === 'pending'
        ? value.agent === null
        : value.agent?.kind === 'codex' && value.agent.name === value.space.expectedAgentName),
  );
export const runtimeActionSchema = z.strictObject({
  attemptId: stateIdSchema,
  key: stateIdSchema,
  kind: z.enum(['input', 'interrupt']),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['pending', 'acknowledged']),
  generation: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1)
    .default(0),
});
export const runtimeInputRetrySchema = z.strictObject({
  attemptId: stateIdSchema,
  key: stateIdSchema,
  digest: runtimeActionSchema.shape.digest,
  generation: runtimeActionSchema.shape.generation,
  launchId: stateIdSchema,
  source: z.literal('host-attestation'),
  notSubmitted: z.literal(true),
  writerStopped: z.literal(true),
  authorizedAt: z.number().int().nonnegative(),
});
export const runtimeStatusSchema = z.strictObject({
  session: runtimeSessionSchema.nullable(),
  state: z.enum(['not_started', 'running', 'blocked', 'unknown']),
  reason: z
    .enum([
      'not_launched',
      'launch_pending',
      'identity_changed',
      'provider_unavailable',
      'policy_blocked',
      'capability_missing',
      'action_pending',
      'agent_blocked',
      'agent_busy',
      'agent_unknown',
      'action_acknowledged',
      'input_retry_authorized',
    ])
    .nullable(),
  agentStatus: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']).nullable(),
  action: runtimeActionSchema.nullable(),
  inputRetry: runtimeInputRetrySchema.optional(),
});
export const runtimeResultSchema = createOperationResultSchema(runtimeStatusSchema);
export type RuntimeSession = z.infer<typeof runtimeSessionSchema>;
export type RuntimeAction = z.infer<typeof runtimeActionSchema>;
export type RuntimeInputRetry = z.infer<typeof runtimeInputRetrySchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
