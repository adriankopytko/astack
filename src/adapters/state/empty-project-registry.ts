import { completed, rejected } from '../../contracts/operation-result.js';
import type { ProjectRegistry } from '../../ports/project-registry.js';

/** Diagnostics with no existing state must not initialize a database. */
export const emptyProjectRegistry: ProjectRegistry = {
  readProject: async () => completed(null),
  readCheckout: async () => completed(null),
  findCheckout: async () => completed(null),
  findRepository: async () => completed(null),
  findRegisteredProject: async () => completed(null),
  readRun: async () => completed(null),
  register: () => rejected('state_read_only', 'The empty registry permits diagnostics only.'),
  list: async () => completed({ items: [], nextCursor: null }),
};
