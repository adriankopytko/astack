import type { OperationResult } from '../contracts/operation-result.js';
import { projectListRequestSchema, type ProjectList } from '../contracts/projects.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { ProjectRegistry } from '../ports/project-registry.js';
import { checkProjectCancellation, observe, projectRejection } from './project-facts.js';

export async function listProjects(
  input: unknown,
  registry: ProjectRegistry,
  signal?: AbortSignal,
): Promise<OperationResult<ProjectList>> {
  const request = parseOperationRequest(projectListRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  try {
    checkProjectCancellation(signal);
    const value = await observe(registry.list(request.value), signal);

    return { schemaVersion: 1, outcome: 'completed', value };
  } catch (error) {
    return projectRejection(error, signal);
  }
}
