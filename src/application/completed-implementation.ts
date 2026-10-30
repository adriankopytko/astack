import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { HandoffRequest, HandoffSource } from '../contracts/handoff.js';
import type { RunStore, RunArtifactReader } from '../ports/runs.js';
import type { ImplementationWorkerInput } from '../ports/implementation.js';
import {
  inspectOwnedAssignment,
  type OwnedAssignmentReaderDependencies,
} from './owned-assignment.js';
import { implementationTask } from './implementation.js';
import { configurationDigest } from '../core/configuration.js';
import {
  implementationInputKey,
  renderImplementationPrompt,
} from '../core/implementation-prompt.js';
import { workerInputDigest } from '../core/worker-input.js';
export interface CompletedImplementationDependencies extends OwnedAssignmentReaderDependencies {
  runs: RunStore;
  artifacts: RunArtifactReader;
  workerInput: Pick<ImplementationWorkerInput, 'receipt'>;
}
export class CompletedImplementationFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Completed implementation evidence is unavailable');
  }
}
function take<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new CompletedImplementationFailure(result);
  }

  return result.value;
}

function fail(code: Parameters<typeof rejected>[0], message: string): never {
  throw new CompletedImplementationFailure(rejected(code, message));
}

export async function inspectCompletedImplementation(
  request: { jobId: string; reportId: string; publication?: HandoffRequest['publication'] },
  deps: CompletedImplementationDependencies,
  signal?: AbortSignal,
) {
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
    (request.publication !== undefined &&
      (request.publication.headSha !== proposal.headCommit ||
        request.publication.headBranch !== proposal.branch.slice('refs/heads/'.length)))
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
  const owned = await inspect();

  if (signal?.aborted) {
    return fail('cancelled', 'Handoff validation was cancelled.');
  }

  const source: HandoffSource = {
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

  return {
    source,
    location: owned.managed.location!,
    reportDigest: configurationDigest(report),
    artifacts: report.request.artifacts,
    job: run.job,
  };
}
