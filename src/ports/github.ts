import type {
  GithubRepository,
  GithubPublication,
  GithubPullRequest,
  GithubPublicationReceipt,
  GithubResult,
  GithubWriteResult,
} from '../contracts/github.js';
import type { ReviewSnapshot, ReviewTarget } from '../contracts/review-task.js';

/** Provider mechanics only; the host supplies authority and journaled intent.
 * publish rejection guarantees no POST was attempted. Uncertain calls must not be
 * retried; use publishGithubEffect for durable single-claim execution/recovery.
 */
export interface GithubProvider {
  inspectPullRequest(
    input: { target: ReviewTarget; root: string },
    signal?: AbortSignal,
  ): Promise<GithubResult<GithubPullRequest>>;
  readChecks(
    input: { target: ReviewTarget; root: string },
    signal?: AbortSignal,
  ): Promise<GithubResult<ReviewSnapshot>>;
  discoverPullRequests(
    input: {
      repository: GithubRepository;
      sourceRepository: string;
      headBranch: string;
      root: string;
    },
    signal?: AbortSignal,
  ): Promise<GithubResult<GithubPullRequest[]>>;
  findPublication(
    input: { publication: GithubPublication; marker: string; root: string },
    signal?: AbortSignal,
  ): Promise<GithubResult<GithubPublicationReceipt | null>>;
  publish(
    input: { publication: GithubPublication; marker: string; root: string },
    signal?: AbortSignal,
  ): Promise<GithubWriteResult<GithubPublicationReceipt>>;
}
