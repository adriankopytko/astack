import { z } from 'zod';
import { hostConfigurationPolicySchema } from './configuration.js';
import { stateIdSchema } from './state.js';
import { createOperationResultSchema } from './operation-result.js';
import { createStateWriteResultSchema } from './state.js';
import { genericHandoffSubmissionSchema } from './generic-handoff.js';

export const workerQueueRequestSchema = z.strictObject({
  kind: z.literal('handoff'),
  submission: genericHandoffSubmissionSchema,
});
export const workerQueueItemSchema = z.strictObject({
  id: stateIdSchema,
  request: workerQueueRequestSchema,
  policy: hostConfigurationPolicySchema,
  runtime: z.string().min(1).max(64),
  contextSnapshot: z
    .strictObject({
      kind: z.enum(['issue', 'pr']),
      body: z.string().max(1_000_000),
      title: z.string().max(256),
      reference: z.string().max(512),
      author: z.string().max(100).optional(),
      state: z.string().max(32).optional(),
      observedAt: z.number().int().nonnegative().optional(),
      updatedAt: z.string().max(64).optional(),
      headSha: z
        .string()
        .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
        .optional(),
      baseSha: z
        .string()
        .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
        .optional(),
    })
    .optional(),
  state: z.enum(['queued', 'preparing', 'prepared', 'started', 'blocked', 'cancelled']),
  jobId: stateIdSchema.nullable(),
  cancelRequested: z.boolean().optional(),
  error: z
    .strictObject({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) })
    .nullable(),
  createdAt: z.number().int().nonnegative(),
});
export const workerQueueReceiptSchema = workerQueueItemSchema
  .omit({ policy: true, contextSnapshot: true })
  .extend({
    worktree: z
      .strictObject({
        id: stateIdSchema,
        operationId: stateIdSchema,
        phase: z.string(),
        path: z.string(),
      })
      .optional(),
  });
export const workerQueueReadResultSchema = createOperationResultSchema(
  workerQueueReceiptSchema.nullable(),
);
export const workerQueueWriteResultSchema = createStateWriteResultSchema(workerQueueReceiptSchema);
export type WorkerQueueItem = z.infer<typeof workerQueueItemSchema>;
export type WorkerQueueReceipt = z.infer<typeof workerQueueReceiptSchema>;
export function workerQueueReceipt(item: WorkerQueueItem): WorkerQueueReceipt {
  const { policy: _policy, contextSnapshot: _contextSnapshot, ...receipt } = item;

  return workerQueueReceiptSchema.parse(receipt);
}
