import { isDeepStrictEqual } from 'node:util';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import {
  handoffExecuteRequestSchema,
  handoffReconcileRequestSchema,
  handoffReadRequestSchema,
  handoffRecordSchema,
  pushIntentSchema,
  pushReceiptSchema,
  type HandoffRequest,
  type HandoffSource,
  type HandoffView,
  type HandoffRecord,
} from '../contracts/handoff.js';
import type { StateWriteResult, StateEffect } from '../contracts/state.js';
import { githubPublicationReceiptSchema } from '../contracts/github.js';
import type { StateStore } from '../ports/state-store.js';
import type { RunStore, RunArtifactReader } from '../ports/runs.js';
import type { GithubProvider } from '../ports/github.js';
import type { HandoffStore, GitPublisher } from '../ports/handoff.js';
import type { ImplementationWorkerInput } from '../ports/implementation.js';
import {
  inspectOwnedAssignment,
  OwnedAssignmentFailure,
  type OwnedAssignmentReaderDependencies,
} from './owned-assignment.js';
import { implementationTask } from './implementation.js';
import { publishGithubEffect } from './github-publication.js';
import { configurationDigest } from '../core/configuration.js';
import {
  implementationInputKey,
  renderImplementationPrompt,
} from '../core/implementation-prompt.js';
import { workerInputDigest } from '../core/worker-input.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';

export interface HandoffDependencies extends OwnedAssignmentReaderDependencies {
  handoffs: HandoffStore;
  state: StateStore;
  runs: RunStore;
  artifacts: RunArtifactReader;
  workerInput: Pick<ImplementationWorkerInput, 'receipt'>;
  publisher: GitPublisher;
  github: GithubProvider;
  now: () => number;
  nextId: () => string;
}
class HandoffFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Handoff evidence unavailable');
  }
}
function take<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new HandoffFailure(result);
  }

  return result.value;
}

function fail(code: Parameters<typeof rejected>[0], message: string): never {
  throw new HandoffFailure(rejected(code, message));
}

function failure(error: unknown) {
  return error instanceof HandoffFailure || error instanceof OwnedAssignmentFailure
    ? error.result
    : rejected(
        'handoff_blocked',
        'Handoff evidence could not be verified; preserve the original intent and inspect before retrying.',
      );
}

function saved(record: HandoffRecord, deps: HandoffDependencies) {
  return (
    take(deps.handoffs.find(record.request.jobId, record.request.key)) ??
    fail('handoff_not_found', 'Saved handoff not found.')
  );
}

async function source(
  request: HandoffRequest,
  deps: HandoffDependencies,
  signal?: AbortSignal,
): Promise<HandoffSource> {
  const run = take(deps.runs.inspect(request.jobId));

  if (
    !run ||
    run.control.phase !== 'completed' ||
    !run.report ||
    run.report.id !== request.reportId
  ) {
    return fail('handoff_blocked', 'Select the accepted completed implementation report.');
  }

  const task = implementationTask(run.job);
  const report = run.report;
  const proposal = report.request.proposal;
  const job = run.job;

  if (
    !task ||
    !('headCommit' in proposal) ||
    proposal.outcome !== 'completed' ||
    report.jobId !== request.jobId ||
    report.attemptId !== job.attempt.id ||
    proposal.jobId !== job.job.id ||
    proposal.attemptId !== job.attempt.id ||
    proposal.projectId !== job.job.projectId ||
    proposal.checkoutId !== job.job.checkoutId ||
    proposal.branch !== job.entry.branch ||
    proposal.baseCommit !== job.entry.commit ||
    proposal.baseCommit !== task.submission.commit ||
    report.evidence.commit !== proposal.headCommit ||
    !proposal.branch.startsWith('refs/heads/') ||
    request.publication.headSha !== proposal.headCommit ||
    request.publication.headBranch !== proposal.branch.slice('refs/heads/'.length)
  ) {
    return fail(
      'handoff_blocked',
      'Report, assignment, branch and publication must identify the same completed implementation commit.',
    );
  }

  const receipt = take(
    deps.workerInput.receipt({ attemptId: job.attempt.id, key: implementationInputKey }),
  );

  if (
    !receipt ||
    receipt.state !== 'acknowledged' ||
    receipt.key !== implementationInputKey ||
    receipt.digest !== report.evidence.inputDigest ||
    receipt.digest !== workerInputDigest('input', renderImplementationPrompt(job, task))
  ) {
    return fail('handoff_blocked', 'Original assignment delivery evidence is missing or changed.');
  }

  for (const check of request.verification.checks) {
    if (
      check.artifact &&
      !report.request.artifacts.some((artifact) => isDeepStrictEqual(artifact, check.artifact))
    ) {
      return fail(
        'handoff_blocked',
        'Verification artifact must match an accepted report artifact.',
      );
    }
  }

  const inspect = async () => {
    const owned = await inspectOwnedAssignment(task.submission, deps, signal, false);

    if (
      owned.root !== task.root ||
      owned.managed.intent.id !== task.worktreeId ||
      owned.selected.git.checkout.head.commit !== proposal.headCommit ||
      !owned.selected.git.status.clean
    ) {
      return fail(
        'handoff_blocked',
        'Publication requires the unchanged clean owned implementation checkout.',
      );
    }

    return owned;
  };

  await inspect();
  take(
    await deps.artifacts.inspect({ root: task.root, artifacts: report.request.artifacts }, signal),
  );
  await inspect();

  if (signal?.aborted) {
    return fail('cancelled', 'Handoff validation was cancelled.');
  }

  return {
    projectId: job.job.projectId,
    repositoryId: job.job.repositoryId,
    checkoutId: job.job.checkoutId,
    attemptId: job.attempt.id,
    worktreeId: task.worktreeId,
    root: task.root,
    branch: proposal.branch,
    baseCommit: proposal.baseCommit,
    headCommit: proposal.headCommit,
    inputDigest: receipt.digest,
  };
}

async function validate(record: HandoffRecord, deps: HandoffDependencies, signal?: AbortSignal) {
  const fresh = await source(record.request, deps, signal);

  if (!isDeepStrictEqual(fresh, record.source)) {
    fail('handoff_blocked', 'Saved handoff source no longer matches this assignment.');
  }
}

function pushIntent(record: HandoffRecord) {
  return pushIntentSchema.parse({
    repository: {
      host: record.request.publication.target.host,
      repository: record.request.publication.sourceRepository,
    },
    branch: record.request.publication.headBranch,
    sha: record.source.headCommit,
    expectedHead: record.request.expectedRemoteHead,
  });
}

async function push(
  record: HandoffRecord,
  deps: HandoffDependencies,
  readOnly: boolean,
  signal?: AbortSignal,
): Promise<StateWriteResult<StateEffect>> {
  const current = take(
    deps.state.inspectRecord({ schemaVersion: 1, entity: 'effect', id: record.pushEffectId }),
  );

  if (current?.entity !== 'effect') {
    return rejected('state_invalid_data', 'Handoff push effect is missing.');
  }

  const effect = current.record;
  const intent = pushIntent(record);

  if (
    effect.intent.attemptId !== record.publicationAttemptId ||
    effect.intent.kind !== 'git-push:v1' ||
    effect.intent.key !== 'push' ||
    !isDeepStrictEqual(effect.intent.payload, { request: intent })
  ) {
    return rejected('state_invalid_data', 'Handoff push intent changed.');
  }

  if (effect.state === 'confirmed' || effect.state === 'cancelled' || (readOnly && !effect.claim)) {
    return { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: effect };
  }

  const reconcile = readOnly || effect.claim !== null || effect.state === 'unknown';
  const claimed = reconcile
    ? {
        schemaVersion: 1 as const,
        outcome: 'persisted' as const,
        disposition: 'existing' as const,
        value: effect,
      }
    : deps.state.claimEffect({
        schemaVersion: 1,
        effectId: effect.intent.id,
        owner: deps.nextId(),
        token: deps.nextId(),
        leaseMs: 30000,
      });

  if (claimed.outcome !== 'persisted') {
    return claimed;
  }

  if (!reconcile && claimed.disposition !== 'updated') {
    return rejected(
      'state_reconciliation_required',
      'Push already has a controller; do not send another write.',
    );
  }

  const claim = claimed.value.claim;

  if (!claim) {
    return rejected('state_reconciliation_required', 'No original push claim is available.');
  }

  let state: 'confirmed' | 'unknown' | 'cancelled' = 'unknown';
  let receipt = null;
  let reason = 'git_write_uncertain';

  try {
    if (reconcile) {
      const observed = await deps.publisher.inspect({ root: record.source.root, intent }, signal);

      if (observed.outcome === 'completed') {
        receipt = observed.value;
      } else {
        reason = observed.error.code;
      }
    } else {
      const result = await deps.publisher.push({ root: record.source.root, intent }, signal);

      if (result.outcome === 'completed') {
        receipt = result.value;
      } else if (result.outcome === 'rejected') {
        state = 'cancelled';
        reason = result.error.code;
      }
    }

    if (receipt) {
      receipt = pushReceiptSchema.parse(receipt);

      if (
        receipt.repository.host !== intent.repository.host ||
        receipt.repository.repository !== intent.repository.repository ||
        receipt.branch !== intent.branch ||
        receipt.sha !== intent.sha
      ) {
        receipt = null;
        state = 'unknown';
      } else {
        state = 'confirmed';
      }
    }
  } catch {
    state = 'unknown';
    receipt = null;
  }

  return deps.state.resolveEffect({
    schemaVersion: 1,
    effectId: effect.intent.id,
    owner: claim.owner,
    token: claim.token,
    state,
    evidence: {
      kind: 'git-push:v1',
      receipt,
      reason: state === 'confirmed' ? null : reason,
      source: reconcile ? 'host-reconciliation' : 'provider',
    },
  });
}

async function verifyRemote(
  record: HandoffRecord,
  deps: HandoffDependencies,
  signal?: AbortSignal,
) {
  const intent = pushIntent(record);
  const observed = take(await deps.publisher.inspect({ root: record.source.root, intent }, signal));
  const parsed = pushReceiptSchema.safeParse(observed);

  if (
    !parsed.success ||
    parsed.data.sha !== intent.sha ||
    parsed.data.branch !== intent.branch ||
    !isDeepStrictEqual(parsed.data.repository, intent.repository)
  ) {
    fail(
      'handoff_target_changed',
      'Fresh remote evidence does not identify the exact intended repository, branch and commit.',
    );
  }
}

async function advance(
  record: HandoffRecord,
  deps: HandoffDependencies,
  readOnly: boolean,
  signal?: AbortSignal,
): Promise<StateWriteResult<HandoffView>> {
  await validate(record, deps, signal);
  const pushed = await push(record, deps, readOnly, signal);

  if (pushed.outcome !== 'persisted') {
    return pushed;
  }

  if (pushed.value.state !== 'confirmed') {
    return {
      schemaVersion: 1,
      outcome: 'persisted',
      disposition: 'updated',
      value: saved(record, deps),
    };
  }

  await validate(record, deps, signal);
  await verifyRemote(record, deps, signal);

  const before = saved(record, deps).publication;

  if (
    before.intent.attemptId !== record.publicationAttemptId ||
    before.intent.kind !== 'github-publication:v1' ||
    before.intent.key !== 'pull-request' ||
    !isDeepStrictEqual(before.intent.payload, { publication: record.request.publication })
  ) {
    return rejected('state_invalid_data', 'Handoff PR publication intent changed.');
  }

  if (before.state === 'cancelled' || (readOnly && !before.claim)) {
    return {
      schemaVersion: 1,
      outcome: 'persisted',
      disposition: 'existing',
      value: saved(record, deps),
    };
  }

  const published = await publishGithubEffect(
    {
      schemaVersion: 1,
      effectId: record.publicationEffectId,
      root: record.source.root,
      mode: before.claim ? 'reconcile' : 'publish',
      originalWriterStopped: before.claim !== null,
    },
    { store: deps.state, provider: deps.github, nextId: deps.nextId },
    signal,
  );

  if (published.outcome !== 'persisted') {
    return published;
  }

  if (published.value.state !== 'confirmed') {
    return {
      schemaVersion: 1,
      outcome: 'persisted',
      disposition: 'updated',
      value: saved(record, deps),
    };
  }

  const receipt = githubPublicationReceiptSchema.parse(published.value.evidence?.receipt);
  const pr = take(
    await deps.github.inspectPullRequest(
      { target: receipt.target, root: record.source.root },
      signal,
    ),
  );
  const p = record.request.publication;

  if (
    pr.target.sha !== record.source.headCommit ||
    pr.target.number !== receipt.target.number ||
    pr.target.host !== p.target.host ||
    pr.target.repository !== p.target.repository ||
    pr.sourceRepository !== p.sourceRepository ||
    pr.headBranch !== p.headBranch ||
    pr.baseBranch !== p.baseBranch ||
    pr.baseSha !== p.baseSha ||
    pr.state !== 'OPEN' ||
    pr.title !== p.title ||
    pr.draft !== p.draft ||
    pr.body !== `${p.body}\n\n${receipt.marker}` ||
    pr.author.toLowerCase() !== p.actor.toLowerCase()
  ) {
    return rejected(
      'handoff_target_changed',
      'Fresh PR evidence no longer matches the exact saved publication.',
    );
  }

  await verifyRemote(record, deps, signal);

  await validate(record, deps, signal);

  return deps.handoffs.accept({ id: record.id, receipt, acceptedAt: deps.now() });
}

export async function finishImplementation(
  input: unknown,
  deps: HandoffDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<HandoffView>> {
  const parsed = parseOperationRequest(handoffExecuteRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Handoff submission was cancelled.');
  }

  try {
    const request = parsed.value.request;
    const previous = take(deps.handoffs.find(request.jobId, request.key));

    if (previous) {
      if (!isDeepStrictEqual(previous.record.request, request)) {
        return rejected(
          'state_conflict',
          'Handoff key already names different publication or verification evidence.',
        );
      }

      if (previous.record.phase === 'accepted') {
        return deps.handoffs.accept({
          id: previous.record.id,
          receipt: previous.record.receipt!,
          acceptedAt: previous.record.acceptedAt!,
        });
      }

      if (previous.record.phase !== 'prepared') {
        return { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: previous };
      }

      return await advance(previous.record, deps, false, signal);
    }

    const bound = await source(request, deps, signal);
    const id = `handoff-${configurationDigest({ jobId: request.jobId, key: request.key })}`;
    const record = handoffRecordSchema.parse({
      schemaVersion: 1,
      id,
      request,
      source: bound,
      phase: 'prepared',
      publicationJobId: `publish-job-${configurationDigest(id)}`,
      publicationAttemptId: `publish-attempt-${configurationDigest(id)}`,
      pushEffectId: `push-${configurationDigest(id)}`,
      publicationEffectId: `pr-${configurationDigest(id)}`,
      createdAt: deps.now(),
      acceptedAt: null,
      receipt: null,
      followUpReview: null,
    });
    const accepted = deps.handoffs.reserve(record);

    if (accepted.outcome !== 'persisted') {
      return accepted;
    }

    return accepted.value.record.phase === 'prepared'
      ? await advance(accepted.value.record, deps, false, signal)
      : accepted;
  } catch (error) {
    return failure(error);
  }
}

export async function reconcileImplementationHandoff(
  input: unknown,
  deps: HandoffDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<HandoffView>> {
  const parsed = parseOperationRequest(handoffReconcileRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Handoff reconciliation was cancelled.');
  }

  try {
    const record = take(deps.handoffs.find(parsed.value.jobId, parsed.value.key));

    if (!record) {
      return rejected('handoff_not_found', 'Handoff not found.');
    }

    if (record.record.phase === 'accepted') {
      return deps.handoffs.accept({
        id: record.record.id,
        receipt: record.record.receipt!,
        acceptedAt: record.record.acceptedAt!,
      });
    }

    return record.record.phase === 'prepared'
      ? await advance(record.record, deps, true, signal)
      : { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: record };
  } catch (error) {
    return failure(error);
  }
}

export function inspectImplementationHandoff(
  input: unknown,
  deps: Pick<HandoffDependencies, 'handoffs'>,
) {
  const parsed = parseOperationRequest(handoffReadRequestSchema, input);

  return parsed.valid ? deps.handoffs.find(parsed.value.jobId, parsed.value.key) : parsed.result;
}
