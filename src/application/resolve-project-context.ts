import {
  checkoutRecordSchema,
  projectContextRequestSchema,
  projectRecordSchema,
  type ProjectContext,
} from '../contracts/project-context.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { ProjectContextReader } from '../ports/project-context-reader.js';

/** Resolve an explicit project from injected read-only facts, without inspecting ambient cwd. */
export async function resolveProjectContext(
  input: unknown,
  reader: ProjectContextReader,
  signal?: AbortSignal,
): Promise<OperationResult<ProjectContext>> {
  const request = parseOperationRequest(projectContextRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const cancelled = () => rejected('cancelled', 'Context resolution was cancelled.');

  if (signal?.aborted) {
    return cancelled();
  }

  try {
    const projectData = await reader.readProject(request.value.projectId, signal);

    if (signal?.aborted) {
      return cancelled();
    }

    if (projectData === null) {
      return rejected('project_not_found', 'Selected project is not registered.');
    }

    const project = projectRecordSchema.safeParse(projectData);

    if (!project.success || project.data.id !== request.value.projectId) {
      return rejected(
        'invalid_context_source',
        'Project source returned invalid or inconsistent facts.',
      );
    }

    const checkoutId = request.value.checkoutId ?? project.data.primaryCheckoutId;
    const checkoutData = await reader.readCheckout(checkoutId, signal);

    if (signal?.aborted) {
      return cancelled();
    }

    if (checkoutData === null) {
      return rejected('checkout_not_found', 'Selected checkout is not registered.');
    }

    const checkout = checkoutRecordSchema.safeParse(checkoutData);

    if (!checkout.success || checkout.data.id !== checkoutId) {
      return rejected(
        'invalid_context_source',
        'Checkout source returned invalid or inconsistent facts.',
      );
    }

    if (checkout.data.projectId !== project.data.id) {
      return rejected(
        'checkout_project_mismatch',
        'Selected checkout belongs to a different project.',
      );
    }

    return completed({
      project: project.data,
      checkout: checkout.data,
      selection: request.value.checkoutId === undefined ? 'primary-checkout' : 'explicit-checkout',
    });
  } catch {
    if (signal?.aborted) {
      return cancelled();
    }

    return rejected('context_source_unavailable', 'Project context source could not be read.');
  }
}
