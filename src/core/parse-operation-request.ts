import { z } from 'zod';
import { rejected, type RejectedResult } from '../contracts/operation-result.js';

/** Validate without copying caller values or validator diagnostics into public errors. */
export function parseOperationRequest<T extends z.ZodType>(
  schema: T,
  input: unknown,
): { valid: true; value: z.output<T> } | { valid: false; result: RejectedResult } {
  const version = z.object({ schemaVersion: z.number().int().positive() }).safeParse(input);

  if (version.success && version.data.schemaVersion !== 1) {
    return {
      valid: false,
      result: rejected(
        'unsupported_contract_version',
        'Only contract schemaVersion 1 is supported.',
      ),
    };
  }

  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    return {
      valid: false,
      result: rejected('invalid_request', 'Request does not match the operation contract.'),
    };
  }

  return { valid: true, value: parsed.data };
}
