import { rejected } from '../../contracts/operation-result.js';
import type { ReviewTargetReader } from '../../ports/review.js';
import type { GhOptions } from './transport.js';
import { createGhProvider } from './provider.js';

/** Paginated commit-bound checks bracketed by unchanged explicit PR observations. */
export function createGhReviewTargetReader(input: GhOptions): ReviewTargetReader {
  const provider = createGhProvider(input);

  return {
    async read(request, signal) {
      const result = await provider.readChecks(request, signal);

      return result.outcome === 'completed'
        ? result
        : rejected(result.error.code, result.error.message);
    },
  };
}
