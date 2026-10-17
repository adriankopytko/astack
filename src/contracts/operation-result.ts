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
    'path_unavailable',
    'not_git_repository',
    'unsupported_repository',
    'git_unavailable',
    'git_failed',
    'git_timed_out',
    'git_output_incomplete',
    'invalid_git_output',
    'base_ref_not_found',
    'base_ref_ambiguous',
    'base_ref_not_commit',
    'repository_changed',
    'state_busy',
    'state_conflict',
    'state_not_found',
    'state_reconciliation_required',
    'state_invalid_data',
    'state_schema_mismatch',
    'state_directory_unsafe',
    'state_unavailable',
    'state_closed',
    'state_read_only',
    'project_context_required',
    'project_selector_conflict',
    'project_registration_conflict',
    'project_checkout_stale',
    'run_not_found',
    'worktree_not_found',
    'worktree_conflict',
    'worktree_configuration_unsupported',
    'configuration_invalid',
    'configuration_unsafe',
    'configuration_unavailable',
    'configuration_blocked',
    'service_already_running',
    'service_unavailable',
    'service_endpoint_unsafe',
    'service_protocol_error',
    'service_stopping',
    'herdr_unavailable',
    'herdr_unsupported',
    'herdr_invalid_output',
    'herdr_not_configured',
    'herdr_conflict',
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
