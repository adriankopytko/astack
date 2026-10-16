import {
  rejected,
  type OperationResult,
  type RejectedResult,
  type OperationErrorCode,
} from '../contracts/operation-result.js';
import {
  checkoutLocationSchema,
  type CheckoutLocation,
  type RegistryCheckout,
} from '../contracts/projects.js';
import type { GitRepositoryInspection } from '../contracts/git.js';
import type { ProjectRegistry } from '../ports/project-registry.js';
import type { GitInspector } from '../ports/git-inspector.js';
import type { CheckoutIdentityReader } from '../ports/checkout-identity-reader.js';
import { inspectGitRepository } from './inspect-git-repository.js';

export interface ProjectDependencies {
  registry: ProjectRegistry;
  git: GitInspector;
  identity: CheckoutIdentityReader;
}
export class ProjectFailure extends Error {
  constructor(readonly result: RejectedResult) {
    super(result.error.code);
  }
}
export function projectFailure(code: OperationErrorCode): never {
  const messages: Partial<Record<OperationErrorCode, string>> = {
    project_context_required:
      'Select a project, checkout, saved run, or explicit repository path; collection directories are not searched.',
    project_selector_conflict:
      'Explicit project, checkout, path, or saved-run selectors identify different targets.',
    project_registration_conflict:
      'Registration conflicts with recorded identities; register the primary checkout first or reconcile the existing registration.',
    project_checkout_stale:
      'Recorded checkout identity no longer matches this filesystem location; reconcile it explicitly.',
    project_not_found: 'The selected project is not registered.',
    checkout_not_found: 'The selected checkout is not registered.',
    run_not_found: 'The selected saved attempt does not exist.',
    cancelled: 'Project operation was cancelled before persistence.',
    invalid_context_source: 'Project sources returned invalid or inconsistent facts.',
  };

  throw new ProjectFailure(
    rejected(code, messages[code] ?? 'Project context could not be resolved.'),
  );
}

export function checkProjectCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    projectFailure('cancelled');
  }
}

export async function observe<T>(
  pending: Promise<OperationResult<T>>,
  signal?: AbortSignal,
): Promise<T> {
  const result = await pending;
  checkProjectCancellation(signal);

  if (result.outcome === 'rejected') {
    throw new ProjectFailure(result);
  }

  return result.value;
}

export async function inspectProjectPath(
  path: string,
  dependencies: ProjectDependencies,
  signal?: AbortSignal,
): Promise<GitRepositoryInspection> {
  return observe(
    inspectGitRepository({ schemaVersion: 1, path }, dependencies.git, signal),
    signal,
  );
}

export async function locateCheckout(
  git: GitRepositoryInspection,
  dependencies: ProjectDependencies,
  signal?: AbortSignal,
): Promise<CheckoutLocation> {
  const location = checkoutLocationSchema.parse(
    await dependencies.identity.read({
      rootPath: git.checkout.rootPath,
      gitDirectory: git.checkout.gitDirectory,
      commonDirectory: git.repository.commonDirectory,
    }),
  );
  checkProjectCancellation(signal);

  if (
    location.root.path !== git.checkout.rootPath ||
    location.gitDirectory.path !== git.checkout.gitDirectory ||
    location.commonDirectory.path !== git.repository.commonDirectory
  ) {
    projectFailure('project_checkout_stale');
  }

  return location;
}

export function sameLocation(left: CheckoutLocation, right: CheckoutLocation): boolean {
  return ['root', 'gitDirectory', 'commonDirectory'].every((key) => {
    const name = key as keyof CheckoutLocation;

    return (
      left[name].path === right[name].path &&
      left[name].device === right[name].device &&
      left[name].inode === right[name].inode
    );
  });
}

export function verifyCheckout(
  checkout: RegistryCheckout,
  git: GitRepositoryInspection,
  location: CheckoutLocation,
): void {
  if (
    checkout.checkout.rootPath !== git.checkout.rootPath ||
    checkout.checkout.gitCommonDirectory !== git.repository.commonDirectory ||
    (checkout.location && !sameLocation(checkout.location, location))
  ) {
    projectFailure('project_checkout_stale');
  }
}

export function projectRejection(error: unknown, signal?: AbortSignal): RejectedResult {
  if (signal?.aborted) {
    return rejected('cancelled', 'Project operation was cancelled before persistence.');
  }

  return error instanceof ProjectFailure
    ? error.result
    : rejected('context_source_unavailable', 'Project sources could not be read.');
}
