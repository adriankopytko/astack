import { z } from 'zod';

export const operationErrorSchema = z.strictObject({
  code: z.enum([
    'invalid_request',
    'unsupported_contract_version',
    'project_not_found',
    'checkout_not_found',
    'checkout_project_mismatch',
    'invalid_context_source',
    'context_source_unavailable',
    'cancelled',
    'unsupported_platform',
  ]),
  message: z.string().min(1),
});

export type OperationError = z.infer<typeof operationErrorSchema>;
export type OperationErrorCode = OperationError['code'];

export const rejectedResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  outcome: z.literal('rejected'),
  error: operationErrorSchema,
});

export type RejectedResult = z.infer<typeof rejectedResultSchema>;
export type CompletedResult<T> = { schemaVersion: 1; outcome: 'completed'; value: T };
export type OperationResult<T> = CompletedResult<T> | RejectedResult;

/** Results describe completed reads or rejection; durable acceptance is a separate contract. */
export function createOperationResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('outcome', [
    z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal('completed'), value }),
    rejectedResultSchema,
  ]);
}

export function completed<T>(value: T): CompletedResult<T> {
  return { schemaVersion: 1, outcome: 'completed', value };
}

export function rejected(code: OperationErrorCode, message: string): RejectedResult {
  return { schemaVersion: 1, outcome: 'rejected', error: { code, message } };
}
