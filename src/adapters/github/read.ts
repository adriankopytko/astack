import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { githubRepositorySchema, type GithubPullRequest } from '../../contracts/github.js';
import { completed, rejected, type OperationResult } from '../../contracts/operation-result.js';
import { createGhSession, ghFailure, type GhOptions } from './transport.js';
import { normalizePullRequest } from './provider.js';

const requestSchema = z.strictObject({
  repository: githubRepositorySchema,
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  root: z.string().refine(isAbsolute),
  maxAgeMs: z.number().int().min(0).max(3_600_000).default(0),
});
const rawIssue = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  title: z.string().max(256),
  body: z.string().max(1_000_000).nullable(),
  state: z.enum(['open', 'closed']),
  updated_at: z.string().max(64),
  user: z.object({ login: z.string().max(100) }),
  pull_request: z.unknown().optional(),
});
export type GithubIssue = {
  repository: z.infer<typeof githubRepositorySchema>;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string;
  updatedAt: string;
};
export type GithubReadSnapshot<T> = { value: T; observedAt: number; cached: boolean };

/** Targeted reads; reuse a single instance to share fresh snapshots and concurrent requests. */
export function createGhReadPrimitives(options: GhOptions) {
  const cache = new Map<string, { observedAt: number; value: unknown }>();
  const pending = new Map<string, Promise<unknown>>();

  async function read<T>(
    kind: 'issue' | 'pull',
    input: unknown,
    signal?: AbortSignal,
  ): Promise<OperationResult<GithubReadSnapshot<T>>> {
    const parsed = requestSchema.safeParse(input);

    if (!parsed.success) {
      return rejected('invalid_request', 'Select a repository, number, root and valid cache age.');
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'GitHub read was cancelled.');
    }

    const { repository, number, root, maxAgeMs } = parsed.data;
    const key = JSON.stringify([kind, repository.host, repository.repository, number, root]);
    const old = cache.get(key);
    const now = options.now();

    if (old && maxAgeMs > 0 && now >= old.observedAt && now - old.observedAt <= maxAgeMs) {
      return completed({
        value: structuredClone(old.value) as T,
        observedAt: old.observedAt,
        cached: true,
      });
    }

    try {
      // Calls with cancellation are kept independent so one caller cannot cancel another.
      let operation = signal ? undefined : pending.get(key);

      if (!operation) {
        operation = (async () => {
          const session = createGhSession(options, root, signal);
          const raw = await session.api(
            repository.host,
            `repos/${repository.repository}/${kind === 'pull' ? 'pulls' : 'issues'}/${number}`,
          );

          if (kind === 'pull') {
            const result = normalizePullRequest(raw, repository);

            if (result.target.number !== number) {
              throw new Error('Mismatched pull request');
            }

            return result;
          }

          const issue = rawIssue.parse(raw);

          if (
            issue.number !== number ||
            issue.pull_request !== undefined ||
            issue.html_url.toLowerCase() !==
              `https://${repository.host}/${repository.repository}/issues/${number}`
          ) {
            throw new Error('Mismatched issue');
          }

          return {
            repository,
            number,
            title: issue.title,
            body: issue.body ?? '',
            state: issue.state,
            author: issue.user.login,
            updatedAt: issue.updated_at,
          };
        })();

        if (!signal) {
          pending.set(key, operation);
          void operation.finally(() => pending.delete(key)).catch(() => {});
        }
      }

      const value = await operation;
      const observedAt = options.now();
      cache.set(key, { value: structuredClone(value), observedAt });

      if (cache.size > 256) {
        cache.delete(cache.keys().next().value!);
      }

      return completed({ value: structuredClone(value) as T, observedAt, cached: false });
    } catch (error) {
      return ghFailure(error);
    }
  }

  return {
    issue: (input: unknown, signal?: AbortSignal) => read<GithubIssue>('issue', input, signal),
    pullRequest: (input: unknown, signal?: AbortSignal) =>
      read<GithubPullRequest>('pull', input, signal),
  };
}
