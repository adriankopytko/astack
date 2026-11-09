import { z } from 'zod';

export const serviceErrorSchema = z.strictObject({
  id: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  operation: z.string().min(1).max(128),
  projectId: z.string().max(128).nullable(),
  jobId: z.string().max(128).nullable(),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2048),
});
export type ServiceError = z.infer<typeof serviceErrorSchema>;
