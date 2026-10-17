import { isDeepStrictEqual } from 'node:util';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { WorktreeStore, WorktreeFiles } from '../ports/worktrees.js';
import type { ServiceDependencies } from './service.js';
import { selectProjectContext } from './select-project-context.js';
export interface OwnedAssignmentDependencies extends ServiceDependencies {
  worktrees: WorktreeStore;
  files: WorktreeFiles;
}
export class OwnedAssignmentFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Owned assignment blocked');
  }
}
function read<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new OwnedAssignmentFailure(result);
  }

  return result.value;
}

export async function inspectOwnedAssignment(
  input: { projectId: string; checkoutId: string; branch: string; commit: string },
  deps: OwnedAssignmentDependencies,
  signal?: AbortSignal,
  initial = true,
) {
  const selected = read(
    await selectProjectContext(
      { schemaVersion: 1, projectId: input.projectId, checkoutId: input.checkoutId },
      deps,
      signal,
    ),
  );
  const managed = read(deps.worktrees.forCheckout(input.checkoutId));

  if (
    !managed ||
    managed.phase !== 'ready' ||
    managed.intent.projectId !== input.projectId ||
    managed.intent.repositoryId !== selected.project?.repository.id ||
    managed.intent.checkoutPath !== selected.checkout?.checkout.rootPath ||
    !isDeepStrictEqual(managed.location, selected.checkout?.location) ||
    managed.intent.branch !== input.branch ||
    selected.git.checkout.head.branch !== input.branch ||
    (initial && (selected.git.checkout.head.commit !== input.commit || !selected.git.status.clean))
  ) {
    throw new OwnedAssignmentFailure(
      rejected(
        'implementation_assignment_changed',
        'Select a clean, ready owned checkout at the exact initial branch and commit.',
      ),
    );
  }

  const files = await deps.files.observe(managed.intent);

  if (files.container !== 'owned' || files.checkout !== 'present') {
    throw new OwnedAssignmentFailure(
      rejected(
        'implementation_assignment_changed',
        'Owned checkout evidence changed; preserve the resource and inspect it.',
      ),
    );
  }

  return { selected, managed, root: managed.intent.checkoutPath };
}
