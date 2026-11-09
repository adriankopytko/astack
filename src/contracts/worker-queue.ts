import { z } from 'zod';
import { hostConfigurationPolicySchema } from './configuration.js';
import {
  implementationWorkerSubmissionSchema,
  reviewWorkerSubmissionSchema,
} from './worker-submission.js';
import { stateIdSchema } from './state.js';
import { createOperationResultSchema } from './operation-result.js';
import { createStateWriteResultSchema } from './state.js';
import { issueSnapshotSchema } from './implementation-task.js';

export const workerQueueRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('implementer'),
    submission: implementationWorkerSubmissionSchema,
  }),
  z.strictObject({ kind: z.literal('reviewer'), submission: reviewWorkerSubmissionSchema }),
]);
export const workerQueueItemSchema = z.strictObject({
  id: stateIdSchema,
  request: workerQueueRequestSchema,
  policy: hostConfigurationPolicySchema,
  runtime: z.string().min(1).max(64),
  issueSnapshot: issueSnapshotSchema.optional(),
  state: z.enum(['queued', 'preparing', 'prepared', 'started', 'blocked', 'cancelled']),
  jobId: stateIdSchema.nullable(),
  cancelRequested: z.boolean().optional(),
  error: z
    .strictObject({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) })
    .nullable(),
  createdAt: z.number().int().nonnegative(),
});
export const workerQueueReceiptSchema = workerQueueItemSchema
  .omit({ policy: true, issueSnapshot: true })
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
  const { policy: _policy, issueSnapshot: _issueSnapshot, ...receipt } = item;

  return workerQueueReceiptSchema.parse(receipt);
}
