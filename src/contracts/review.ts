import { z } from 'zod';
import { serviceJobSchema } from './service.js';
import { createStateWriteResultSchema } from './state.js';
import { createOperationResultSchema } from './operation-result.js';
import { reviewProgressSchema, reviewTaskSchema } from './review-task.js';
export * from './review-task.js';
export const reviewJobSchema = z.strictObject({
  job: serviceJobSchema,
  review: reviewProgressSchema,
  assignment: reviewTaskSchema,
});
export const reviewReadResultSchema = createOperationResultSchema(reviewJobSchema.nullable());
export const reviewSubmitResultSchema = createStateWriteResultSchema(reviewJobSchema);
export type ReviewJob = z.infer<typeof reviewJobSchema>;
