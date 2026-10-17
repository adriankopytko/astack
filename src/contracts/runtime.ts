import { z } from 'zod';
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
  text: z
    .string()
    .min(1)
    .max(16_384)
    .refine((value) => {
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);

        if (code !== 9 && code !== 10 && (code < 32 || code === 127)) {
          return false;
        }
      }

      return (
        Buffer.from(value, 'utf8').toString('utf8') === value && Buffer.byteLength(value) <= 16_384
      );
    }),
});
export const runtimeInterruptRequestSchema = runtimeRequestSchema.extend({ key: stateIdSchema });
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
    agent: herdrAgentSchema.nullable(),
  })
  .refine(
    (value) =>
      value.space.kind === 'worker' &&
      value.space.phase === 'ready' &&
      value.space.attemptId === value.attemptId &&
      value.space.handle !== null &&
      (value.phase === 'pending'
        ? value.agent === null
        : value.agent?.kind === 'codex' &&
          value.agent.nativeSessionId !== null &&
          value.agent.name === value.space.expectedAgentName),
  );
export const runtimeActionSchema = z.strictObject({
  attemptId: stateIdSchema,
  key: stateIdSchema,
  kind: z.enum(['input', 'interrupt']),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['pending', 'acknowledged']),
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
    ])
    .nullable(),
  agentStatus: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']).nullable(),
  action: runtimeActionSchema.nullable(),
});
export const runtimeResultSchema = createOperationResultSchema(runtimeStatusSchema);
export type RuntimeSession = z.infer<typeof runtimeSessionSchema>;
export type RuntimeAction = z.infer<typeof runtimeActionSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
