import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, relative } from 'node:path';
import {
  cleanupRequestSchema,
  cleanupReadSchema,
  cleanupExecuteSchema,
  cleanupControlSchema,
  cleanupReconcileSchema,
  type CleanupPlan,
} from '../contracts/cleanup.js';
import { rejected } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { CleanupStore } from '../ports/cleanup.js';
import type { RunStore, RunShutdownVerifier } from '../ports/runs.js';
import type { WorktreeDependencies } from './worktree-evidence.js';
import { configurationDigest } from '../core/configuration.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { removeWorktree, reconcileWorktree } from './worktrees.js';
import { reconcileRun } from './run-reconciliation.js';

export interface CleanupDependencies {
  cleanups: CleanupStore;
  runs: RunStore;
  worktrees: WorktreeDependencies;
  /** Host selected cwd, outside the checkout being removed. */
  cwd: string;
  shutdown?: RunShutdownVerifier;
  now(): number;
}

export function inspectCleanup(input: unknown, deps: Pick<CleanupDependencies, 'cleanups'>) {
  const parsed = parseOperationRequest(cleanupReadSchema, input);

  return parsed.valid ? deps.cleanups.read(parsed.value.jobId) : parsed.result;
}

export function requestCleanup(
  input: unknown,
  deps: CleanupDependencies,
): StateWriteResult<CleanupPlan> {
  const parsed = parseOperationRequest(cleanupRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const request = parsed.value;
  const previous = deps.cleanups.read(request.jobId);

  if (previous.outcome === 'rejected') {
    return previous;
  }

  if (previous.value) {
    return isDeepStrictEqual(previous.value.request, request)
      ? { schemaVersion: 1, outcome: 'persisted', value: previous.value, disposition: 'existing' }
      : rejected('state_conflict', 'This run already has a different cleanup request.');
  }

  const selected = deps.runs.inspect(request.jobId);

  if (selected.outcome === 'rejected') {
    return selected;
  }

  const run = selected.value;

  if (!run || !['completed', 'failed', 'cancelled'].includes(run.control.phase)) {
    return rejected('cleanup_blocked', 'Cleanup requires a terminal delegated run.');
  }

  const worktree = deps.worktrees.store.forCheckout(run.job.job.checkoutId);

  if (worktree.outcome === 'rejected') {
    return worktree;
  }

  if (!worktree.value || worktree.value.phase !== 'ready') {
    return rejected('cleanup_blocked', 'Select a ready owned task checkout.');
  }

  const now = deps.now();

  return deps.cleanups.reserve({
    schemaVersion: 1,
    id: `cleanup-${configurationDigest(request.jobId)}`,
    request,
    projectId: run.job.job.projectId,
    repositoryId: run.job.job.repositoryId,
    attemptId: run.job.attempt.id,
    checkoutId: run.job.job.checkoutId,
    worktreeId: worktree.value.intent.id,
    branch: worktree.value.intent.branch,
    commit: run.report?.evidence.commit ?? run.job.attempt.commit,
    reportId: run.control.reportId,
    phase: 'requested',
    reason: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export function controlCleanup(
  input: unknown,
  deps: Pick<CleanupDependencies, 'cleanups' | 'now'>,
) {
  const parsed = parseOperationRequest(cleanupControlSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  return deps.cleanups.transition({
    jobId: parsed.value.jobId,
    expectedRevision: parsed.value.expectedRevision,
    phase: { suspend: 'suspended', resume: 'requested', cancel: 'cancelled' }[
      parsed.value.action
    ] as CleanupPlan['phase'],
    reason: parsed.value.action === 'resume' ? null : parsed.value.action,
    now: deps.now(),
  });
}

/** Caller excludes all other cleanup writers for the entire operation. No timers authorize shutdown. */
export async function executeCleanup(
  input: unknown,
  deps: CleanupDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<CleanupPlan>> {
  const parsed = parseOperationRequest(cleanupExecuteSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const request = parsed.value;
  const selected = deps.cleanups.read(request.jobId);

  if (selected.outcome === 'rejected') {
    return selected;
  }

  const plan = selected.value;

  if (!plan || plan.revision !== request.expectedRevision) {
    return rejected('state_conflict', 'Inspect the exact cleanup plan and revision.');
  }

  if (plan.phase === 'completed') {
    return { schemaVersion: 1, outcome: 'persisted', value: plan, disposition: 'existing' };
  }

  if (!['requested', 'blocked'].includes(plan.phase)) {
    return rejected(
      'state_reconciliation_required',
      'Resume suspended plans; reconcile started writers explicitly.',
    );
  }

  function block(reason: string, current = plan!) {
    if (current.phase === 'blocked' && current.reason === reason) {
      return {
        schemaVersion: 1 as const,
        outcome: 'persisted' as const,
        value: current,
        disposition: 'existing' as const,
      };
    }

    return deps.cleanups.transition({
      jobId: request.jobId,
      expectedRevision: current.revision,
      phase: 'blocked',
      reason,
      now: deps.now(),
    });
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Cleanup was cancelled before claiming effects.');
  }

  if (deps.now() < plan.request.notBefore) {
    return block('retention');
  }

  const authorized = deps.cleanups.authorize(plan);

  if (authorized.outcome === 'rejected') {
    return block(authorized.error.code);
  }

  const tree = deps.worktrees.store.read(plan.worktreeId);

  if (tree.outcome === 'rejected') {
    return tree;
  }

  if (!tree.value) {
    return block('worktree_not_found');
  }

  const relativeCwd = relative(tree.value.intent.checkoutPath, deps.cwd);

  if (
    !isAbsolute(deps.cwd) ||
    relativeCwd === '' ||
    (!isAbsolute(relativeCwd) && relativeCwd !== '..' && !relativeCwd.startsWith('../'))
  ) {
    return block('cleanup_cwd_inside_checkout');
  }

  if (request.shutdown) {
    if (
      !deps.shutdown ||
      request.shutdown.jobId !== plan.request.jobId ||
      request.shutdown.attemptId !== plan.attemptId
    ) {
      return block('shutdown_verifier_required');
    }

    const result = await reconcileRun(
      request.shutdown,
      { runs: deps.runs, shutdown: deps.shutdown },
      signal,
    );

    if (result.outcome !== 'persisted') {
      return result;
    }
  }

  const run = deps.runs.inspect(plan.request.jobId);

  if (run.outcome === 'rejected') {
    return run;
  }

  if (
    !run.value ||
    run.value.cleanup.retainedResourceCount > 0 ||
    run.value.resumes.some((resume) => ['authorized', 'pending', 'unknown'].includes(resume.state))
  ) {
    return block('resources_retained');
  }

  if (
    run.value.job.entry.claim !== null &&
    run.value.job.entry.observation?.state !== 'not_started'
  ) {
    const proof = run.value.cleanup.reconciliation;

    if (!proof || !deps.shutdown) {
      return block('shutdown_required');
    }

    try {
      const fresh = await deps.shutdown.verify({ run: run.value, request: proof.request }, signal);

      if (
        fresh.outcome === 'rejected' ||
        !isDeepStrictEqual(fresh.value.request, proof.request) ||
        !isDeepStrictEqual(fresh.value.workerHandle, proof.workerHandle) ||
        !isDeepStrictEqual(fresh.value.resourceBindings, proof.resourceBindings)
      ) {
        return block('shutdown_unverified');
      }
    } catch {
      return block('shutdown_unverified');
    }
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Cleanup was cancelled before claiming removal.');
  }

  const claimed = deps.cleanups.transition({
    jobId: request.jobId,
    expectedRevision: plan.revision,
    phase: 'started',
    reason: null,
    now: deps.now(),
  });

  if (claimed.outcome !== 'persisted') {
    return claimed;
  }

  const current = claimed.value;
  const store = deps.worktrees.store;
  const result = await removeWorktree(
    { schemaVersion: 1, id: plan.worktreeId },
    {
      ...deps.worktrees,
      store: {
        forCheckout: (id) => store.forCheckout(id),
        read: (id) => store.read(id),
        find: (projectId, key) => store.find(projectId, key),
        reserve: (intent, operationId) => store.reserve(intent, operationId),
        finish: (record, phase, location, reconciliation) =>
          store.finish(record, phase, location, reconciliation),
        beginRemoval: (record, operationId, head) =>
          store.beginRemoval(record, operationId, head, {
            jobId: request.jobId,
            revision: current.revision,
          }),
      },
    },
    signal,
  );

  if (result.outcome === 'removed') {
    return deps.cleanups.transition({
      jobId: request.jobId,
      expectedRevision: current.revision,
      phase: 'completed',
      reason: null,
      now: deps.now(),
    });
  }

  // Pending/uncertain removals retain the nonexpiring claim. Explicit reconciliation is required.
  if (result.outcome === 'pending' || result.outcome === 'uncertain') {
    return { schemaVersion: 1, outcome: 'persisted', disposition: 'updated', value: current };
  }

  return block(
    result.outcome === 'blocked'
      ? result.reason
      : result.outcome === 'rejected'
        ? result.error.code
        : 'worktree_unverified',
    current,
  );
}

/** Only after the host has stopped/excluded original writers and their children. Never replays removal. */
export async function reconcileCleanup(
  input: unknown,
  deps: CleanupDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<CleanupPlan>> {
  const parsed = parseOperationRequest(cleanupReconcileSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const selected = deps.cleanups.read(parsed.value.jobId);

  if (selected.outcome === 'rejected') {
    return selected;
  }

  const plan = selected.value;

  if (!plan || plan.revision !== parsed.value.expectedRevision || plan.phase !== 'started') {
    return rejected('state_conflict', 'Select the exact started cleanup revision.');
  }

  const tree = deps.worktrees.store.read(plan.worktreeId);

  if (tree.outcome === 'rejected') {
    return tree;
  }

  if (!tree.value || !['ready', 'removing', 'removed'].includes(tree.value.phase)) {
    return rejected('cleanup_blocked', 'Owned checkout requires separate inspection.');
  }

  if (tree.value.phase === 'removing') {
    const result = await reconcileWorktree(
      {
        schemaVersion: 1,
        id: plan.worktreeId,
        operationId: tree.value.operationId,
        writerStopped: true,
      },
      deps.worktrees,
      signal,
    );

    if (result.outcome !== 'reconciled') {
      return rejected('cleanup_blocked', 'Removal remains unresolved; inspect the owned worktree.');
    }
  }

  const fresh = deps.worktrees.store.read(plan.worktreeId);

  if (fresh.outcome === 'rejected') {
    return fresh;
  }

  // A removed record still requires fresh filesystem/Git absence evidence.
  if (fresh.value?.phase === 'removed') {
    const result = await removeWorktree(
      { schemaVersion: 1, id: plan.worktreeId },
      deps.worktrees,
      signal,
    );

    if (result.outcome !== 'removed' || result.record.removalCommit !== plan.commit) {
      return rejected('cleanup_blocked', 'Removed checkout absence could not be verified.');
    }

    return deps.cleanups.transition({
      jobId: plan.request.jobId,
      expectedRevision: plan.revision,
      phase: 'completed',
      reason: null,
      now: deps.now(),
    });
  }

  return deps.cleanups.transition({
    jobId: plan.request.jobId,
    expectedRevision: plan.revision,
    phase: 'requested',
    reason: 'writers_stopped',
    reconciliation: true,
    now: deps.now(),
  });
}
