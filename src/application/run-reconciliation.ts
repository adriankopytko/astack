import { isDeepStrictEqual } from 'node:util';
import { runReconcileRequestSchema } from '../contracts/run-reconciliation.js';
import { rejected } from '../contracts/operation-result.js';
import type { RunStore, RunShutdownVerifier } from '../ports/runs.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { RunView } from '../contracts/runs.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';

/** Explicit offline host operation. Caller holds coordinator ownership throughout verification and commit. */
export async function reconcileRun(
  input: unknown,
  deps: { runs: RunStore; shutdown: RunShutdownVerifier },
  signal?: AbortSignal,
): Promise<StateWriteResult<RunView>> {
  const parsed = parseOperationRequest(runReconcileRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Reconciliation was cancelled.');
  }

  const request = parsed.value;
  const previous = deps.runs.reconciliation(request.jobId);

  if (previous.outcome === 'rejected') {
    return previous;
  }

  if (previous.value) {
    return isDeepStrictEqual(previous.value.request, request)
      ? deps.runs.reconcile(previous.value)
      : rejected('state_conflict', 'This run has a different saved reconciliation.');
  }

  const selected = deps.runs.inspect(request.jobId);

  if (selected.outcome === 'rejected') {
    return selected;
  }

  const run = selected.value;

  if (
    !run ||
    run.job.attempt.id !== request.attemptId ||
    run.control.revision !== request.expectedRevision ||
    !['completed', 'failed', 'cancel_requested', 'cancelled'].includes(run.control.phase) ||
    run.resumes.some((resume) => ['authorized', 'pending', 'unknown'].includes(resume.state))
  ) {
    return rejected(
      'state_conflict',
      'Select an exact terminal or cancellation-requested run without unresolved continuations.',
    );
  }

  try {
    const verification = await deps.shutdown.verify({ run, request }, signal);

    if (verification.outcome === 'rejected') {
      return verification;
    }

    if (!isDeepStrictEqual(verification.value.request, request)) {
      return rejected(
        'state_conflict',
        'Shutdown evidence identifies a different reconciliation request.',
      );
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Reconciliation was cancelled before commit.');
    }

    return deps.runs.reconcile(verification.value);
  } catch {
    return rejected(
      'runtime_unavailable',
      'Shutdown could not be verified; all resource holds remain.',
    );
  }
}
