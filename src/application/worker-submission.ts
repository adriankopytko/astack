import { isDeepStrictEqual } from 'node:util';
import {
  implementationWorkerSubmissionSchema,
  reviewWorkerSubmissionSchema,
} from '../contracts/worker-submission.js';
import { rejected } from '../contracts/operation-result.js';
import { workerWorktreeKey } from '../core/worker-key.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { selectProjectContext } from './select-project-context.js';
import { resolveConfiguration } from './configuration.js';
import { prepareWorkerWorktree } from './worker-worktree.js';
import {
  submitImplementation,
  implementationTask,
  type ImplementationDependencies,
} from './implementation.js';
import { submitReview, type ReviewDependencies } from './review.js';
import type { HerdrDependencies } from './herdr.js';
import type { WorktreeDependencies } from './worktree-evidence.js';
import type { ReviewTarget } from '../contracts/review-task.js';
import type { OperationResult } from '../contracts/operation-result.js';
import { sameReviewTarget } from '../core/review-gates.js';

type Dependencies = {
  implementation: ImplementationDependencies;
  review: ReviewDependencies;
  worktrees: WorktreeDependencies;
  herdr: HerdrDependencies;
  implementationBase: {
    resolve(root: string, signal?: AbortSignal): Promise<OperationResult<string>>;
  };
  reviewCommit?: {
    ensure(
      target: ReviewTarget,
      root: string,
      signal?: AbortSignal,
    ): Promise<OperationResult<null>>;
  };
};

/** Prepare one dedicated worker checkout and submit the saved assignment. */
export async function submitWorkerTask(
  kind: 'implementer' | 'reviewer',
  input: unknown,
  deps: Dependencies,
  signal?: AbortSignal,
) {
  const parsed =
    kind === 'implementer'
      ? parseOperationRequest(implementationWorkerSubmissionSchema, input)
      : parseOperationRequest(reviewWorkerSubmissionSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Worker submission was cancelled before setup.');
  }

  const request = parsed.value;
  const agent = request.agent ?? kind;
  const prior =
    kind === 'reviewer'
      ? deps.review.queue.reviewRequest({ projectId: request.projectId, key: request.key })
      : deps.implementation.queue.find({
          projectId: request.projectId,
          role: agent,
          key: request.key,
          workflow: 'implementation',
        });

  if (prior.outcome === 'rejected') {
    return prior;
  }

  if (prior.value) {
    const saved =
      'submission' in prior.value
        ? prior.value.submission
        : implementationTask(prior.value)?.submission;
    const schema =
      kind === 'implementer' ? implementationWorkerSubmissionSchema : reviewWorkerSubmissionSchema;
    const old = saved
      ? schema.safeParse(
          Object.fromEntries(
            Object.entries(saved).filter(
              ([key]) => !['checkoutId', 'branch', 'commit'].includes(key),
            ),
          ),
        )
      : null;
    const { baseCommit, ...wanted } =
      'baseCommit' in request ? request : { ...request, baseCommit: undefined };

    if (
      !saved ||
      !old?.success ||
      !isDeepStrictEqual(old.data, wanted) ||
      (baseCommit !== undefined && baseCommit !== saved.commit)
    ) {
      return rejected('state_conflict', 'This task key already identifies a different submission.');
    }

    return kind === 'implementer'
      ? submitImplementation(saved, deps.implementation, signal)
      : submitReview(saved, deps.review, signal);
  }

  const worktreeKey = workerWorktreeKey(kind, request);
  const digest = worktreeKey.slice(-32);
  const branch = `refs/heads/astack/${kind === 'reviewer' ? 'code-review' : 'implementation'}-${digest}`;
  const previous = deps.worktrees.store.find(request.projectId, worktreeKey);

  if (previous.outcome === 'rejected') {
    return previous;
  }

  const source = await selectProjectContext(
    { schemaVersion: 1, projectId: request.projectId },
    deps.worktrees,
    signal,
  );

  if (source.outcome === 'rejected') {
    return source;
  }

  let base =
    'target' in request
      ? request.target.sha
      : (request.baseCommit ?? request.fixOf?.commit ?? previous.value?.intent.baseCommit);

  if (!base && kind === 'implementer') {
    const main = await deps.implementationBase.resolve(source.value.git.checkout.rootPath, signal);

    if (main.outcome === 'rejected') {
      return main;
    }

    base = main.value;
  }

  if (!base) {
    return rejected('invalid_request', 'The project needs a base commit before starting a worker.');
  }

  if ('fixOf' in request && request.fixOf && base !== request.fixOf.commit) {
    return rejected('invalid_request', 'A review fix must start at the reviewed commit.');
  }

  if (
    previous.value &&
    (previous.value.intent.baseCommit !== base || previous.value.intent.branch !== branch)
  ) {
    return rejected(
      'worktree_conflict',
      'This task key already identifies a different worker checkout.',
    );
  }

  const config = await resolveConfiguration(
    { schemaVersion: 1, projectId: request.projectId, role: agent, request: request.request },
    deps.implementation,
    signal,
  );

  if (config.outcome === 'rejected') {
    return config;
  }

  if (config.value.status !== 'ready') {
    return rejected(
      'configuration_blocked',
      `Configure the ${agent} agent before starting this task.`,
    );
  }

  if ('target' in request && deps.reviewCommit) {
    const snapshot = await deps.review.targets.read(
      { target: request.target, root: source.value.git.checkout.rootPath },
      signal,
    );

    if (snapshot.outcome === 'rejected') {
      return snapshot;
    }

    if (!sameReviewTarget(snapshot.value.target, request.target)) {
      return rejected(
        'review_target_changed',
        'The pull request changed before the review worker was prepared.',
      );
    }

    const fetched = await deps.reviewCommit.ensure(
      request.target,
      source.value.git.checkout.rootPath,
      signal,
    );

    if (fetched.outcome === 'rejected') {
      return fetched;
    }
  }

  const tree = await prepareWorkerWorktree(
    { schemaVersion: 1, projectId: request.projectId, key: worktreeKey, branch, baseCommit: base },
    {
      worktrees: deps.worktrees,
      herdr: deps.herdr,
      workspacePrefix:
        config.value.snapshot?.effective.roles[agent]?.workspacePrefix ??
        (kind === 'reviewer' ? 'CR' : 'IMPL'),
    },
    signal,
  );

  if (tree.outcome === 'rejected' || tree.outcome === 'uncertain') {
    return tree;
  }

  if (tree.outcome !== 'prepared' && tree.outcome !== 'reused') {
    return rejected(
      'state_reconciliation_required',
      `Worker setup is ${tree.outcome}; inspect worktree ${tree.record.intent.id} before retrying.`,
    );
  }

  const { baseCommit: _baseCommit, ...withoutBase } =
    'baseCommit' in request ? request : { ...request, baseCommit: undefined };
  const submission = {
    ...withoutBase,
    checkoutId: tree.record.intent.checkoutId,
    branch,
    commit: base,
  };

  return kind === 'implementer'
    ? submitImplementation(submission, deps.implementation, signal)
    : submitReview(submission, deps.review, signal);
}
