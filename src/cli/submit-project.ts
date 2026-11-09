import { selectProjectContext } from '../application/select-project-context.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import { gitExecutable } from '../core/host-git.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { ProjectRegistry } from '../ports/project-registry.js';

/** An explicit project wins; otherwise resolve the caller's registered repository. */
export async function submissionProject(
  projectId: string | undefined,
  registry: ProjectRegistry,
  executable?: string,
): Promise<OperationResult<string>> {
  if (projectId !== undefined) {
    return completed(projectId);
  }

  const git = await gitExecutable(executable);

  if (!git) {
    return rejected('git_unavailable', 'Select a trusted Git executable to identify the project.');
  }

  const context = await selectProjectContext(
    { schemaVersion: 1, callerDirectory: process.cwd() },
    {
      registry,
      git: createGitInspector({ executable: git, runner: nodeProcessRunner }),
      identity: nodeCheckoutIdentityReader,
    },
  );

  if (context.outcome === 'rejected') {
    return context;
  }

  return context.value.project?.registeredAt != null
    ? completed(context.value.project.project.id)
    : rejected(
        'project_not_found',
        'Initialize this project with astack init or select a registered project with --project.',
      );
}
