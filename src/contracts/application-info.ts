import { z } from 'zod';

export const applicationInfoSchema = z.object({
  name: z.literal('astack'),
  version: z.string(),
  stage: z.literal('foundation'),
});

export type ApplicationInfo = z.infer<typeof applicationInfoSchema>;
