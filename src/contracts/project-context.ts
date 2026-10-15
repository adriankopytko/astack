import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createOperationResultSchema } from './operation-result.js';

const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const absolutePath = z.string().refine((value) => isAbsolute(value) && !value.includes('\0'), {
  message: 'Expected an absolute host path without NUL characters',
});

export const projectIdSchema = opaqueId.brand<'ProjectId'>();
export const checkoutIdSchema = opaqueId.brand<'CheckoutId'>();
export const repositoryIdSchema = opaqueId.brand<'RepositoryId'>();

export const projectRecordSchema = z.strictObject({
  id: projectIdSchema,
  primaryCheckoutId: checkoutIdSchema,
});

export const checkoutRecordSchema = z.strictObject({
  id: checkoutIdSchema,
  projectId: projectIdSchema,
  repositoryId: repositoryIdSchema,
  rootPath: absolutePath,
  gitCommonDirectory: absolutePath,
});

export const projectContextRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
  checkoutId: checkoutIdSchema.optional(),
});

export const projectContextSchema = z
  .strictObject({
    project: projectRecordSchema,
    checkout: checkoutRecordSchema,
    selection: z.enum(['primary-checkout', 'explicit-checkout']),
  })
  .superRefine((value, context) => {
    if (value.checkout.projectId !== value.project.id) {
      context.addIssue({ code: 'custom', message: 'Checkout must belong to the selected project' });
    }

    if (
      value.selection === 'primary-checkout' &&
      value.checkout.id !== value.project.primaryCheckoutId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Primary selection must use the primary checkout',
      });
    }
  });

export const projectContextResultSchema = createOperationResultSchema(projectContextSchema);
export type ProjectId = z.infer<typeof projectIdSchema>;
export type CheckoutId = z.infer<typeof checkoutIdSchema>;
export type RepositoryId = z.infer<typeof repositoryIdSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type CheckoutRecord = z.infer<typeof checkoutRecordSchema>;
export type ProjectContextRequest = z.infer<typeof projectContextRequestSchema>;
export type ProjectContext = z.infer<typeof projectContextSchema>;
