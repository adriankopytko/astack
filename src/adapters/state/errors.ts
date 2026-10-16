import {
  rejected,
  type OperationErrorCode,
  type RejectedResult,
} from '../../contracts/operation-result.js';

export class StateError extends Error {
  constructor(readonly code: OperationErrorCode) {
    super(code);
  }
}

export function stateFailure(code: OperationErrorCode): never {
  throw new StateError(code);
}

export function sqliteCode(error: unknown): number | null {
  if (
    error !== null &&
    typeof error === 'object' &&
    'errcode' in error &&
    typeof error.errcode === 'number'
  ) {
    return error.errcode & 255;
  }

  return null;
}

const messages: Partial<Record<OperationErrorCode, string>> = {
  worktree_conflict:
    'Worktree ownership or lifecycle state conflicts; inspect the current record before continuing.',
  project_registration_conflict:
    'Registration conflicts with recorded project or checkout identities.',
  project_checkout_stale:
    'The recorded checkout filesystem identity has changed; reconcile it explicitly.',
  state_read_only: 'This state connection permits reads only.',
  state_busy:
    'Local state is busy; retry the storage operation after the competing transaction ends.',
  state_conflict:
    'State identity, idempotency key, claim, or resource conflicts with an existing record.',
  state_not_found: 'The selected state record does not exist.',
  state_reconciliation_required:
    'An expired claim or uncertain effect requires reconciliation before another execution.',
  state_invalid_data:
    'Stored state is invalid; preserve the database and inspect it before continuing.',
  state_schema_mismatch:
    'State schema or migration history is unsupported; use a compatible version.',
  state_directory_unsafe:
    'Use an owned private state directory outside repositories; preserve existing files and metadata.',
  state_unavailable:
    'Local state could not be accessed; inspect the state directory before retrying.',
  state_closed:
    'The state connection is closed or requires reopening after an uncertain transaction.',
};

export function stateRejection(error: unknown): RejectedResult {
  const sqlite = sqliteCode(error);
  const code =
    error instanceof StateError
      ? error.code
      : sqlite === 5 || sqlite === 6
        ? 'state_busy'
        : sqlite === 19
          ? 'state_conflict'
          : sqlite === 11 || sqlite === 26
            ? 'state_invalid_data'
            : 'state_unavailable';

  return rejected(code, messages[code] ?? 'Local state could not be accessed.');
}
