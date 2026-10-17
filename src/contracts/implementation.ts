import { z } from 'zod';
import { serviceJobSchema } from './service.js';
import { createStateWriteResultSchema } from './state.js';
import { createOperationResultSchema } from './operation-result.js';
import { implementationProgressSchema } from './implementation-task.js';
export * from './implementation-task.js';

export const implementationJobSchema = z.strictObject({
  job: serviceJobSchema,
  implementation: implementationProgressSchema,
});
export const implementationReadResultSchema = createOperationResultSchema(
  implementationJobSchema.nullable(),
);
export const implementationSubmitResultSchema =
  createStateWriteResultSchema(implementationJobSchema);
export type ImplementationJob = z.infer<typeof implementationJobSchema>;
