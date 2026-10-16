import { join, relative } from 'node:path';
import {
  worktreeIntentSchema,
  worktreePrepareRequestSchema,
  worktreeIdRequestSchema,
  worktreeReconcileRequestSchema,
  type WorktreeRecord,
  type WorktreeResult,
} from '../contracts/worktrees.js';
import { rejected } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { checkProjectCancellation, observe } from './project-facts.js';
import { selectProjectContext } from './select-project-context.js';
import {
  blocked,
  pending,
  readWorktree,
  take,
  gitSucceeded,
  ownedProblem,
  worktreeEvidence,
  worktreeFailure,
  type WorktreeDependencies,
} from './worktree-evidence.js';

export async function prepareWorktree(
  input: unknown,
  dependencies: WorktreeDependencies,
  signal?: AbortSignal,
): Promise<WorktreeResult> {
  const request = parseOperationRequest(worktreePrepareRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  let record: WorktreeRecord | null = null;
  let effectPossible = false;

  try {
    checkProjectCancellation(signal);
    const selection = await observe(
      selectProjectContext(
        {
          schemaVersion: 1,
          projectId: request.value.projectId,
          ...(request.value.checkoutId === undefined
            ? {}
            : { checkoutId: request.value.checkoutId }),
          ...(request.value.runId === undefined ? {} : { runId: request.value.runId }),
        },
        dependencies,
        signal,
      ),
      signal,
    );
    const checkout = selection.checkout;
    const project = selection.project;

    if (!checkout?.location || !project || selection.registration !== 'registered') {
      return rejected(
        'project_not_found',
        'Register the selected source checkout before preparing a worktree.',
      );
    }

    const existing = take(dependencies.store.find(project.project.id, request.value.key));

    if (
      selection.run &&
      (selection.run.branch !== request.value.branch ||
        selection.run.commit !== request.value.baseCommit)
    ) {
      return rejected(
        'project_selector_conflict',
        'The branch and base must match the saved attempt assignment.',
      );
    }

    if (existing) {
      record = existing;

      if (
        existing.intent.branch !== request.value.branch ||
        existing.intent.baseCommit !== request.value.baseCommit ||
        existing.intent.sourceCheckoutId !== checkout.checkout.id ||
        existing.intent.run?.id !== selection.run?.id ||
        existing.intent.managedRoot !== dependencies.managedRoot
      ) {
        return rejected(
          'worktree_conflict',
          'This worktree key is already bound to a different assignment.',
        );
      }

      if (['preparing', 'removing'].includes(existing.phase)) {
        return pending(existing, 'pending_writer');
      }

      if (existing.phase !== 'ready') {
        return blocked(existing, 'abandoned');
      }

      const evidence = await worktreeEvidence(existing, dependencies, signal);
      const problem = ownedProblem(existing, evidence);

      return problem
        ? blocked(existing, problem)
        : {
            schemaVersion: 1,
            outcome: 'reused',
            record: existing,
            observation: evidence.observation,
          };
    }

    const rootRelation = relative(selection.git.checkout.rootPath, dependencies.managedRoot);

    if (rootRelation === '' || (!rootRelation.startsWith('..') && !rootRelation.startsWith('/'))) {
      return rejected(
        'invalid_request',
        'Managed worktree storage must be outside the source checkout.',
      );
    }

    if (selection.git.refs.some((ref) => ref.name === request.value.branch)) {
      return rejected(
        'worktree_conflict',
        'The requested task branch already exists; existing branches are not adopted.',
      );
    }

    const id = dependencies.nextId('worktree');
    const intent = worktreeIntentSchema.parse({
      schemaVersion: 1,
      id,
      key: request.value.key,
      projectId: project.project.id,
      repositoryId: project.repository.id,
      sourceCheckoutId: checkout.checkout.id,
      checkoutId: dependencies.nextId('checkout'),
      sourceRoot: checkout.checkout.rootPath,
      sourceLocation: checkout.location,
      run: selection.run,
      branch: request.value.branch,
      baseCommit: request.value.baseCommit,
      managedRoot: dependencies.managedRoot,
      containerPath: join(dependencies.managedRoot, id),
      checkoutPath: join(dependencies.managedRoot, id, 'checkout'),
      markerToken: dependencies.nextId('marker'),
      createdAt: dependencies.now(),
    });
    await observe(dependencies.effects.preflight(intent, signal), signal);
    checkProjectCancellation(signal);
    const reserved = dependencies.store.reserve(intent, dependencies.nextId('operation'));

    if (reserved.outcome !== 'persisted') {
      return reserved;
    }

    record = reserved.value;

    if (reserved.disposition !== 'created') {
      return pending(record, 'pending_writer');
    }

    effectPossible = true;

    if (signal?.aborted) {
      return pending(record, 'cancelled');
    }

    await dependencies.files.prepare(intent);

    if (signal?.aborted) {
      return pending(record, 'cancelled');
    }

    const effect = await dependencies.effects.create(intent, signal);

    if (!gitSucceeded(effect)) {
      return pending(record, effect.outcome === 'cancelled' ? 'cancelled' : 'provider_uncertain');
    }

    const evidence = await worktreeEvidence(record, dependencies);
    const problem = ownedProblem(record, evidence);

    if (problem) {
      return pending(record, problem);
    }

    const finished = dependencies.store.finish(
      record,
      'ready',
      evidence.observation.location,
      null,
    );

    if (finished.outcome === 'uncertain') {
      return finished;
    }

    if (finished.outcome !== 'persisted') {
      return pending(record);
    }

    return {
      schemaVersion: 1,
      outcome: 'prepared',
      record: finished.value,
      observation: evidence.observation,
    };
  } catch (error) {
    return worktreeFailure(error, record, effectPossible);
  }
}

export async function inspectWorktree(
  input: unknown,
  dependencies: WorktreeDependencies,
  signal?: AbortSignal,
): Promise<WorktreeResult> {
  const request = parseOperationRequest(worktreeIdRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  let record: WorktreeRecord | null = null;

  try {
    checkProjectCancellation(signal);
    record = readWorktree(request.value.id, dependencies);
    const evidence = await worktreeEvidence(record, dependencies, signal);

    return { schemaVersion: 1, outcome: 'inspected', record, observation: evidence.observation };
  } catch (error) {
    return worktreeFailure(error, record, false);
  }
}

export async function removeWorktree(
  input: unknown,
  dependencies: WorktreeDependencies,
  signal?: AbortSignal,
): Promise<WorktreeResult> {
  const request = parseOperationRequest(worktreeIdRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  let record: WorktreeRecord | null = null;
  let effectPossible = false;

  try {
    checkProjectCancellation(signal);
    record = readWorktree(request.value.id, dependencies);

    if (record.phase === 'removed') {
      const evidence = await worktreeEvidence(record, dependencies, signal);

      return removalAbsent(record, evidence)
        ? { schemaVersion: 1, outcome: 'removed', record, observation: evidence.observation }
        : blocked(record, 'identity_changed');
    }

    if (record.phase !== 'ready') {
      return pending(record, 'pending_writer');
    }

    await observe(dependencies.effects.preflight(record.intent, signal), signal);
    const before = await worktreeEvidence(record, dependencies, signal);
    const problem = ownedProblem(record, before);

    if (problem) {
      return blocked(record, problem);
    }

    checkProjectCancellation(signal);
    const removing = dependencies.store.beginRemoval(
      record,
      dependencies.nextId('operation'),
      before.observation.git?.checkout.head.commit ?? '',
    );

    if (removing.outcome !== 'persisted') {
      return removing.outcome === 'rejected' &&
        removing.error.code === 'state_reconciliation_required'
        ? blocked(record, 'resource_in_use')
        : removing;
    }

    record = removing.value;
    const latest = await worktreeEvidence(record, dependencies);
    const changed = ownedProblem(record, latest);

    if (changed || signal?.aborted) {
      const restored = dependencies.store.finish(record, 'ready', record.location, null);

      return restored.outcome === 'persisted'
        ? blocked(restored.value, changed ?? 'cancelled')
        : pending(record);
    }

    effectPossible = true;
    const effect = await dependencies.effects.remove(record.intent, signal);

    if (!gitSucceeded(effect)) {
      return pending(record, effect.outcome === 'cancelled' ? 'cancelled' : 'provider_refused');
    }

    const after = await worktreeEvidence(record, dependencies);

    if (!removalAbsent(record, after)) {
      return pending(record, 'partial');
    }

    const finished = dependencies.store.finish(record, 'removed', record.location, null);

    if (finished.outcome === 'uncertain') {
      return finished;
    }

    if (finished.outcome !== 'persisted') {
      return pending(record);
    }

    return {
      schemaVersion: 1,
      outcome: 'removed',
      record: finished.value,
      observation: after.observation,
    };
  } catch (error) {
    return worktreeFailure(error, record, effectPossible || record?.phase === 'removing');
  }
}

function removalAbsent(
  record: WorktreeRecord,
  evidence: Awaited<ReturnType<typeof worktreeEvidence>>,
): boolean {
  return (
    evidence.observation.container === 'owned' &&
    evidence.observation.checkout === 'absent' &&
    !evidence.source.git.worktrees.some((tree) => tree.path === record.intent.checkoutPath) &&
    evidence.source.git.refs.find((ref) => ref.name === record.intent.branch)?.objectId ===
      record.removalCommit
  );
}

export async function reconcileWorktree(
  input: unknown,
  dependencies: WorktreeDependencies,
  signal?: AbortSignal,
): Promise<WorktreeResult> {
  const request = parseOperationRequest(worktreeReconcileRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  let record: WorktreeRecord | null = null;

  try {
    checkProjectCancellation(signal);
    record = readWorktree(request.value.id, dependencies);

    if (record.operationId !== request.value.operationId) {
      return rejected(
        'worktree_conflict',
        'The quiescence assertion must identify the current pending operation.',
      );
    }

    const evidence = await worktreeEvidence(record, dependencies, signal);

    if (!['preparing', 'removing'].includes(record.phase)) {
      return { schemaVersion: 1, outcome: 'reconciled', record, observation: evidence.observation };
    }

    let phase: 'ready' | 'removed' | 'abandoned';
    let location = record.location;
    const intent = record.intent;

    if (record.phase === 'removing' && removalAbsent(record, evidence)) {
      phase = 'removed';
    } else if (
      record.phase === 'preparing' &&
      evidence.observation.checkout === 'absent' &&
      ['absent', 'owned'].includes(evidence.observation.container) &&
      !evidence.source.git.worktrees.some((tree) => tree.path === intent.checkoutPath) &&
      !evidence.source.git.refs.some((ref) => ref.name === intent.branch)
    ) {
      phase = 'abandoned';
    } else {
      const problem = ownedProblem(record, evidence);

      if (problem) {
        return blocked(record, problem);
      }

      phase = 'ready';
      location = evidence.observation.location;
    }

    checkProjectCancellation(signal);
    const settled = dependencies.store.finish(record, phase, location, {
      operationId: record.operationId,
      source: 'host-attestation',
      at: dependencies.now(),
    });

    return settled.outcome === 'persisted'
      ? {
          schemaVersion: 1,
          outcome: 'reconciled',
          record: settled.value,
          observation: evidence.observation,
        }
      : settled;
  } catch (error) {
    return worktreeFailure(error, record, record !== null);
  }
}
