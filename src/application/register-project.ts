import {
  projectRegistrationRequestSchema,
  projectRegistrationSchema,
  type ProjectRegistrationResult,
} from '../contracts/projects.js';
import {
  projectIdSchema,
  checkoutIdSchema,
  repositoryIdSchema,
} from '../contracts/project-context.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import {
  checkProjectCancellation,
  inspectProjectPath,
  locateCheckout,
  observe,
  projectFailure,
  projectRejection,
  sameLocation,
  verifyCheckout,
  type ProjectDependencies,
} from './project-facts.js';

export interface ProjectRegistrationDependencies extends ProjectDependencies {
  nextId(kind: 'project' | 'repository' | 'checkout'): string;
  now(): number;
}

export async function registerProject(
  input: unknown,
  dependencies: ProjectRegistrationDependencies,
  signal?: AbortSignal,
): Promise<ProjectRegistrationResult> {
  const request = parseOperationRequest(projectRegistrationRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  try {
    checkProjectCancellation(signal);
    const git = await inspectProjectPath(request.value.path, dependencies, signal);
    const location = await locateCheckout(git, dependencies, signal);
    const registry = dependencies.registry;
    const repository = await observe(
      registry.findRepository(git.repository.commonDirectory),
      signal,
    );
    const existingCheckout = await observe(registry.findCheckout(git.checkout.rootPath), signal);

    if (existingCheckout) {
      verifyCheckout(existingCheckout, git, location);
    }

    let project = repository
      ? await observe(registry.findRegisteredProject(repository.id), signal)
      : null;

    if (!project && existingCheckout) {
      project = await observe(registry.readProject(existingCheckout.checkout.projectId), signal);
    }

    if (!project && request.value.projectId !== undefined) {
      project = await observe(registry.readProject(request.value.projectId), signal);
    }

    if (
      (project &&
        request.value.projectId !== undefined &&
        project.project.id !== request.value.projectId) ||
      (project && existingCheckout && existingCheckout.checkout.projectId !== project.project.id)
    ) {
      projectFailure('project_registration_conflict');
    }

    if (
      project &&
      (project.repository.commonDirectory !== git.repository.commonDirectory ||
        project.repository.objectFormat !== git.repository.objectFormat)
    ) {
      projectFailure('project_checkout_stale');
    }

    if (project?.registeredAt != null) {
      const primary = await observe(
        registry.readCheckout(project.project.primaryCheckoutId),
        signal,
      );
      const common = primary?.location?.commonDirectory;

      if (
        !primary?.registered ||
        !common ||
        common.path !== location.commonDirectory.path ||
        common.device !== location.commonDirectory.device ||
        common.inode !== location.commonDirectory.inode
      ) {
        projectFailure('project_checkout_stale');
      }
    }

    const projectId =
      project?.project.id ??
      request.value.projectId ??
      projectIdSchema.parse(dependencies.nextId('project'));
    const repositoryId =
      repository?.id ?? repositoryIdSchema.parse(dependencies.nextId('repository'));
    const checkoutId =
      existingCheckout?.checkout.id ?? checkoutIdSchema.parse(dependencies.nextId('checkout'));

    if (
      (project && project.repository.id !== repositoryId) ||
      (existingCheckout && existingCheckout.checkout.repositoryId !== repositoryId) ||
      (project?.registeredAt === null && project.project.primaryCheckoutId !== checkoutId)
    ) {
      projectFailure('project_registration_conflict');
    }

    const time = dependencies.now();
    const registration = projectRegistrationSchema.parse({
      project: project?.project ?? { id: projectId, primaryCheckoutId: checkoutId },
      repository: repository ?? {
        id: repositoryId,
        commonDirectory: git.repository.commonDirectory,
        objectFormat: git.repository.objectFormat,
      },
      checkout: existingCheckout?.checkout ?? {
        id: checkoutId,
        projectId,
        repositoryId,
        rootPath: git.checkout.rootPath,
        gitCommonDirectory: git.repository.commonDirectory,
      },
      projectRegisteredAt: project?.registeredAt ?? time,
      checkoutRegisteredAt: time,
      location,
    });
    const latest = await inspectProjectPath(request.value.path, dependencies, signal);
    const latestLocation = await locateCheckout(latest, dependencies, signal);

    if (
      !sameLocation(location, latestLocation) ||
      latest.repository.objectFormat !== git.repository.objectFormat
    ) {
      projectFailure('project_checkout_stale');
    }

    checkProjectCancellation(signal);

    try {
      return registry.register(registration);
    } catch {
      return {
        schemaVersion: 1,
        outcome: 'uncertain',
        error: {
          code: 'state_write_uncertain',
          message: 'Registration persistence is uncertain; inspect the registry before retrying.',
        },
      };
    }
  } catch (error) {
    return projectRejection(error, signal);
  }
}
