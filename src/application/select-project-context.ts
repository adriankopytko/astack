import { completed, type OperationResult } from '../contracts/operation-result.js';
import {
  projectSelectionRequestSchema,
  projectSelectionSchema,
  type ProjectSelection,
  type RegistryCheckout,
} from '../contracts/projects.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import {
  checkProjectCancellation,
  inspectProjectPath,
  locateCheckout,
  observe,
  projectFailure,
  projectRejection,
  ProjectFailure,
  verifyCheckout,
  type ProjectDependencies,
} from './project-facts.js';

export async function selectProjectContext(
  input: unknown,
  dependencies: ProjectDependencies,
  signal?: AbortSignal,
): Promise<OperationResult<ProjectSelection>> {
  const request = parseOperationRequest(projectSelectionRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  try {
    checkProjectCancellation(signal);
    const { registry } = dependencies;
    const { projectId, checkoutId, runId, path, callerDirectory } = request.value;
    const run = runId === undefined ? null : await observe(registry.readRun(runId), signal);

    if (runId !== undefined && !run) {
      projectFailure('run_not_found');
    }

    if (
      run &&
      ((projectId !== undefined && projectId !== run.projectId) ||
        (checkoutId !== undefined && checkoutId !== run.checkoutId))
    ) {
      projectFailure('project_selector_conflict');
    }

    let selected: RegistryCheckout | null = null;
    let source: ProjectSelection['source'];
    let target = path;

    if (run || checkoutId !== undefined) {
      selected = await observe(registry.readCheckout(run?.checkoutId ?? checkoutId ?? ''), signal);

      if (!selected?.registered) {
        projectFailure('checkout_not_found');
      }

      target ??= selected.checkout.rootPath;
      source = run ? 'saved-run' : 'explicit-checkout';
    } else if (projectId !== undefined && path === undefined) {
      const project = await observe(registry.readProject(projectId), signal);

      if (project?.registeredAt == null) {
        projectFailure('project_not_found');
      }

      selected = await observe(registry.readCheckout(project.project.primaryCheckoutId), signal);

      if (!selected?.registered) {
        projectFailure('checkout_not_found');
      }

      target = selected.checkout.rootPath;
      source = 'explicit-project';
    } else {
      target ??= callerDirectory;
      source = path === undefined ? 'caller-directory' : 'explicit-path';
    }

    if (!target) {
      projectFailure('project_context_required');
    }

    let git;

    try {
      git = await inspectProjectPath(target, dependencies, signal);
    } catch (error) {
      if (
        selected &&
        path === undefined &&
        error instanceof ProjectFailure &&
        ['path_unavailable', 'not_git_repository', 'unsupported_repository'].includes(
          error.result.error.code,
        )
      ) {
        projectFailure('project_checkout_stale');
      }

      if (
        !selected &&
        path === undefined &&
        projectId === undefined &&
        checkoutId === undefined &&
        runId === undefined &&
        error instanceof ProjectFailure &&
        error.result.error.code === 'not_git_repository'
      ) {
        projectFailure('project_context_required');
      }

      throw error;
    }

    const location = await locateCheckout(git, dependencies, signal);

    if (selected && selected.checkout.rootPath !== git.checkout.rootPath) {
      projectFailure('project_selector_conflict');
    }

    selected ??= await observe(registry.findCheckout(git.checkout.rootPath), signal);

    if (selected) {
      verifyCheckout(selected, git, location);
    }

    const repository = await observe(
      registry.findRepository(git.repository.commonDirectory),
      signal,
    );
    const project = selected
      ? await observe(registry.readProject(selected.checkout.projectId), signal)
      : repository
        ? await observe(registry.findRegisteredProject(repository.id), signal)
        : null;

    if (projectId !== undefined && project?.registeredAt == null) {
      const requestedProject = await observe(registry.readProject(projectId), signal);

      if (requestedProject?.registeredAt != null) {
        projectFailure('project_selector_conflict');
      }

      projectFailure('project_not_found');
    }

    if (project?.registeredAt != null) {
      const primary = await observe(
        registry.readCheckout(project.project.primaryCheckoutId),
        signal,
      );
      const common = primary?.location?.commonDirectory;

      if (
        !common ||
        common.path !== location.commonDirectory.path ||
        common.device !== location.commonDirectory.device ||
        common.inode !== location.commonDirectory.inode
      ) {
        projectFailure('project_checkout_stale');
      }
    }

    if (
      (projectId !== undefined && project?.project.id !== projectId) ||
      (run && (project?.project.id !== run.projectId || repository?.id !== run.repositoryId))
    ) {
      projectFailure('project_selector_conflict');
    }

    if (
      project &&
      (project.repository.commonDirectory !== git.repository.commonDirectory ||
        project.repository.objectFormat !== git.repository.objectFormat ||
        (selected && selected.checkout.repositoryId !== project.repository.id))
    ) {
      projectFailure('project_checkout_stale');
    }

    const registration =
      selected?.registered && project?.registeredAt != null
        ? 'registered'
        : project?.registeredAt != null
          ? 'unregistered-checkout'
          : 'unregistered-repository';
    const value = projectSelectionSchema.parse({
      source,
      registration,
      project,
      checkout: selected,
      git,
      run,
      readiness: {
        delegation: 'unavailable',
        reasons: [
          ...(registration === 'registered' ? [] : ['registration_required']),
          'execution_policy_not_implemented',
          'delegation_not_implemented',
        ],
        providers: {
          git: 'ready',
          codex: 'not_checked',
          herdr: 'not_checked',
          github: 'not_checked',
        },
        configuration: { source: 'none', status: 'not_implemented' },
      },
    });
    checkProjectCancellation(signal);

    return completed(value);
  } catch (error) {
    return projectRejection(error, signal);
  }
}
