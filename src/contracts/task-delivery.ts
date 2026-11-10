import { z } from 'zod';
import { configurationDigestSchema } from './configuration.js';
import { stateIdSchema } from './state.js';

export const workerInputReceiptSchema = z.strictObject({
  key: stateIdSchema,
  digest: configurationDigestSchema,
  state: z.enum(['pending', 'acknowledged']),
});
export const workerInputObservationSchema = z.strictObject({
  receipt: workerInputReceiptSchema.nullable(),
  blocker: z
    .enum(['needs_decision', 'busy', 'policy_blocked', 'identity_changed', 'provider_unavailable'])
    .nullable(),
});
export const taskProgressSchema = z.strictObject({
  state: z.enum([
    'queued',
    'starting',
    'started',
    'needs_decision',
    'blocked',
    'failed',
    'unknown',
    'awaiting_result',
    'completed',
    'cancelled',
  ]),
  delivery: z.enum(['not_submitted', 'pending', 'acknowledged']),
  reason: z.string().min(1).max(128).nullable(),
  acceptedOutcome: z.enum(['completed', 'failed', 'cancelled']).nullable(),
});
export type WorkerInputReceipt = z.infer<typeof workerInputReceiptSchema>;
export type WorkerInputObservation = z.infer<typeof workerInputObservationSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
