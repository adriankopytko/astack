import { z } from 'zod';
import { createOperationResultSchema } from './operation-result.js';

export const applicationInfoRequestSchema = z.strictObject({ schemaVersion: z.literal(1) });

export const applicationInfoSchema = z.strictObject({
  name: z.literal('astack'),
  version: z.string().min(1),
  stage: z.literal('foundation'),
});

export type ApplicationInfo = z.infer<typeof applicationInfoSchema>;
export type ApplicationInfoRequest = z.infer<typeof applicationInfoRequestSchema>;
export const applicationInfoResultSchema = createOperationResultSchema(applicationInfoSchema);
