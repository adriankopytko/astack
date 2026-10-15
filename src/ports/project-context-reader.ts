import type { CheckoutId, ProjectId } from '../contracts/project-context.js';

/** Read-only projections, not persisted layouts. Null means absent; other data is validated. */
export interface ProjectContextReader {
  readProject(id: ProjectId, signal?: AbortSignal): Promise<unknown>;
  readCheckout(id: CheckoutId, signal?: AbortSignal): Promise<unknown>;
}
