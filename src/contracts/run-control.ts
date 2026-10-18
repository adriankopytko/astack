import { z } from 'zod';
import { stateIdSchema } from './state.js';
export const runControlSchema = z.strictObject({
  phase: z.enum([
    'active',
    'needs_decision',
    'completed',
    'failed',
    'cancel_requested',
    'cancelled',
  ]),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reportId: stateIdSchema.nullable(),
});
export type RunControl = z.infer<typeof runControlSchema>;
