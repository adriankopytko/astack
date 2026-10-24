import type { CiReader } from '../../ports/ci.js';
import { createGhProvider, type GhProviderOptions } from './provider.js';
/** One bracketed provider read; each invocation receives its pre-reserved hard API ceiling. */
export function createGhCiReader(options: GhProviderOptions): CiReader {
  return {
    read(input, signal) {
      return createGhProvider({ ...options, maxRequests: input.maxRequests }).readChecks(
        { target: input.target, root: input.root },
        signal,
      );
    },
  };
}
