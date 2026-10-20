import { z } from 'zod';
import { completed } from '../../contracts/operation-result.js';
import {
  githubRepositorySchema,
  githubBranchSchema,
  githubPublicationSchema,
  githubPullRequestSchema,
  githubPublicationReceiptSchema,
  type GithubPublication,
  type GithubPullRequest,
  type GithubPublicationReceipt,
} from '../../contracts/github.js';
import { reviewTargetSchema, reviewSnapshotSchema } from '../../contracts/review-task.js';
import type { GithubProvider } from '../../ports/github.js';
import {
  createPrivateArtifactDirectory,
  openPrivateArtifact,
} from '../../core/private-artifacts.js';
import { createGhSession, GhFailure, ghFailure, type GhOptions } from './transport.js';

const rawPr = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  draft: z.boolean(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }),
  head: z.object({
    sha: reviewTargetSchema.shape.sha,
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({
    sha: reviewTargetSchema.shape.sha,
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
});
const remoteComment = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  html_url: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
});
const remoteReview = remoteComment.extend({
  commit_id: reviewTargetSchema.shape.sha.nullable(),
  state: z.string(),
  pull_request_url: z.string(),
});
const markerSchema = githubPublicationReceiptSchema.shape.marker;
const receiptBody = (p: GithubPublication, marker: string) => `${p.body}\n\n${marker}`;

function pull(value: unknown, repository: { host: string; repository: string }): GithubPullRequest {
  const pr = rawPr.parse(value);

  if (
    pr.html_url.toLowerCase() !==
      `https://${repository.host}/${repository.repository}/pull/${pr.number}` ||
    pr.base.repo.full_name.toLowerCase() !== repository.repository
  ) {
    throw new GhFailure('github_invalid_output');
  }

  return githubPullRequestSchema.parse({
    target: { ...repository, number: pr.number, sha: pr.head.sha },
    baseSha: pr.base.sha,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    sourceRepository: pr.head.repo?.full_name.toLowerCase() ?? null,
    state: pr.state === 'open' ? 'OPEN' : pr.merged_at ? 'MERGED' : 'CLOSED',
    draft: pr.draft,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user.login,
  });
}

function samePublication(p: GithubPublication, pr: GithubPullRequest) {
  if (p.kind === 'pull-request') {
    return (
      pr.target.sha === p.headSha &&
      pr.baseSha === p.baseSha &&
      pr.baseBranch === p.baseBranch &&
      pr.headBranch === p.headBranch &&
      pr.sourceRepository === p.sourceRepository &&
      pr.title === p.title &&
      pr.draft === p.draft
    );
  }

  return pr.target.number === p.target.number && pr.target.sha === p.target.sha;
}

export interface GhProviderOptions extends GhOptions {
  artifactParent?: string;
}

/** Only explicit repository paths, bounded page reads and one POST per publication call. */
export function createGhProvider(options: GhProviderOptions): GithubProvider {
  function context(root: string, signal?: AbortSignal) {
    const session = createGhSession(options, root, signal);
    const inspect = async (target: z.infer<typeof reviewTargetSchema>) => {
      const value = pull(
        await session.api(target.host, `repos/${target.repository}/pulls/${target.number}`),
        target,
      );

      if (value.target.number !== target.number || value.target.sha !== target.sha) {
        throw new GhFailure('review_target_changed');
      }

      return value;
    };

    const discover = async (
      repository: z.infer<typeof githubRepositorySchema>,
      sourceRepository: string,
      headBranch: string,
    ) => {
      githubRepositorySchema.shape.repository.parse(sourceRepository);
      githubBranchSchema.parse(headBranch);
      const owner = sourceRepository.split('/')[0];
      const items = await session.pages(
        repository.host,
        `repos/${repository.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${headBranch}`)}&sort=created&direction=asc`,
      );
      const prs = items.map((item) => pull(item, repository));
      const ids = new Set(prs.map((pr) => pr.target.number));

      if (
        ids.size !== prs.length ||
        prs.some((pr) => pr.sourceRepository !== sourceRepository || pr.headBranch !== headBranch)
      ) {
        throw new GhFailure('github_invalid_output');
      }

      return prs;
    };

    return { session, inspect, discover };
  }

  async function find(
    p: GithubPublication,
    marker: string,
    c: ReturnType<typeof context>,
  ): Promise<GithubPublicationReceipt | null> {
    const expected = receiptBody(p, marker);
    const candidates: GithubPublicationReceipt[] = [];

    if (p.kind === 'pull-request') {
      const prs = await c.discover(p.target, p.sourceRepository, p.headBranch);

      for (const pr of prs.filter((pr) => pr.body.includes(marker))) {
        if (
          !samePublication(p, pr) ||
          pr.body !== expected ||
          pr.author.toLowerCase() !== p.actor.toLowerCase()
        ) {
          throw new GhFailure('github_conflict');
        }

        candidates.push(
          githubPublicationReceiptSchema.parse({
            schemaVersion: 1,
            kind: p.kind,
            marker,
            target: pr.target,
            id: pr.target.number,
            actor: pr.author,
            observedAt: options.now(),
          }),
        );
      }
    } else {
      // Historical review/comment evidence remains SHA-bound even after a PR advances.
      const endpoint =
        p.kind === 'comment'
          ? `issues/${p.target.number}/comments`
          : `pulls/${p.target.number}/reviews`;
      const items = await c.session.pages(
        p.target.host,
        `repos/${p.target.repository}/${endpoint}`,
      );
      const seen = new Set<number>();

      for (const item of items) {
        const comment = p.kind === 'review' ? remoteReview.parse(item) : remoteComment.parse(item);

        if (seen.has(comment.id)) {
          throw new GhFailure('github_invalid_output');
        }

        seen.add(comment.id);

        if (!comment.body?.includes(marker)) {
          continue;
        }

        const expectedUrl = `https://${p.target.host}/${p.target.repository}/pull/${p.target.number}#${p.kind === 'comment' ? 'issuecomment-' : 'pullrequestreview-'}${comment.id}`;

        if (
          comment.html_url.toLowerCase() !== expectedUrl ||
          comment.body !== expected ||
          comment.user === null ||
          comment.user.login.toLowerCase() !== p.actor.toLowerCase()
        ) {
          throw new GhFailure('github_conflict');
        }

        if (p.kind === 'review') {
          const review = remoteReview.parse(item);
          const apiHost =
            p.target.host === 'github.com' ? 'api.github.com' : `${p.target.host}/api/v3`;

          if (
            review.commit_id !== p.target.sha ||
            review.state !== (p.event === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED') ||
            review.pull_request_url.toLowerCase() !==
              `https://${apiHost}/repos/${p.target.repository}/pulls/${p.target.number}`
          ) {
            throw new GhFailure('github_conflict');
          }
        }

        candidates.push(
          githubPublicationReceiptSchema.parse({
            schemaVersion: 1,
            kind: p.kind,
            marker,
            target: p.target,
            id: comment.id,
            actor: comment.user.login,
            observedAt: options.now(),
          }),
        );
      }
    }

    if (candidates.length > 1) {
      throw new GhFailure('github_conflict');
    }

    return candidates[0] ?? null;
  }

  return {
    async inspectPullRequest(input, signal) {
      try {
        return completed(
          await context(input.root, signal).inspect(reviewTargetSchema.parse(input.target)),
        );
      } catch (error) {
        return ghFailure(error);
      }
    },
    async readChecks(input, signal) {
      try {
        const target = reviewTargetSchema.parse(input.target);
        const c = context(input.root, signal);
        const before = await c.inspect(target);
        const checkPage = z.object({ check_runs: z.array(z.unknown()) });
        const runs = await c.session.pages(
          target.host,
          `repos/${target.repository}/commits/${target.sha}/check-runs?filter=latest`,
          (value) => checkPage.parse(value).check_runs,
        );
        const statuses = await c.session.pages(
          target.host,
          `repos/${target.repository}/commits/${target.sha}/statuses`,
        );
        const checks: {
          name: string;
          state: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
        }[] = [];
        const runIds = new Set<number>();

        for (const item of runs) {
          const run = z
            .object({
              id: z.number().int().positive(),
              head_sha: reviewTargetSchema.shape.sha,
              name: z.string(),
              status: z.enum([
                'queued',
                'in_progress',
                'completed',
                'waiting',
                'pending',
                'requested',
              ]),
              conclusion: z.string().nullable(),
            })
            .parse(item);

          if (run.head_sha !== target.sha || runIds.has(run.id)) {
            throw new GhFailure('github_invalid_output');
          }

          runIds.add(run.id);
          let state: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' = 'pending';

          if (run.status === 'completed') {
            const conclusion = run.conclusion;

            if (conclusion === 'success') {
              state = 'pass';
            } else if (conclusion === 'neutral' || conclusion === 'skipped') {
              state = 'skipping';
            } else if (conclusion === 'cancelled') {
              state = 'cancel';
            } else if (
              ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(
                conclusion ?? '',
              )
            ) {
              state = 'fail';
            } else {
              throw new GhFailure('github_invalid_output');
            }
          }

          checks.push({ name: run.name, state });
        }

        const latest = new Map<
          string,
          { id: number; state: 'error' | 'failure' | 'pending' | 'success' }
        >();
        const statusIds = new Set<number>();

        for (const item of statuses) {
          const status = z
            .object({
              id: z.number().int().positive(),
              context: z.string(),
              state: z.enum(['error', 'failure', 'pending', 'success']),
            })
            .parse(item);

          if (statusIds.has(status.id)) {
            throw new GhFailure('github_invalid_output');
          }

          statusIds.add(status.id);

          if ((latest.get(status.context)?.id ?? 0) < status.id) {
            latest.set(status.context, status);
          }
        }

        for (const [name, status] of latest) {
          checks.push({
            name,
            state:
              status.state === 'success' ? 'pass' : status.state === 'pending' ? 'pending' : 'fail',
          });
        }

        const after = await c.inspect(target);

        if (JSON.stringify(before) !== JSON.stringify(after)) {
          throw new GhFailure('review_target_changed');
        }

        return completed(
          reviewSnapshotSchema.parse({
            target,
            baseSha: before.baseSha,
            state: before.state,
            draft: before.draft,
            sourceRepository: before.sourceRepository,
            checks: checks.sort((a, b) => a.name.localeCompare(b.name)),
            observedAt: options.now(),
          }),
        );
      } catch (error) {
        return ghFailure(error);
      }
    },
    async discoverPullRequests(input, signal) {
      try {
        const repo = githubRepositorySchema.parse(input.repository);

        return completed(
          await context(input.root, signal).discover(
            repo,
            input.sourceRepository,
            input.headBranch,
          ),
        );
      } catch (error) {
        return ghFailure(error);
      }
    },
    async findPublication(input, signal) {
      try {
        const p = githubPublicationSchema.parse(input.publication);
        markerSchema.parse(input.marker);

        return completed(await find(p, input.marker, context(input.root, signal)));
      } catch (error) {
        return ghFailure(error);
      }
    },
    async publish(input, signal) {
      let sent = false;

      try {
        const p = githubPublicationSchema.parse(input.publication);
        markerSchema.parse(input.marker);
        const c = context(input.root, signal);
        const actor = z
          .object({ login: z.string() })
          .parse(await c.session.api(p.target.host, 'user'));

        if (actor.login.toLowerCase() !== p.actor.toLowerCase()) {
          throw new GhFailure('github_auth_required');
        }

        const existing = await find(p, input.marker, c);

        if (existing) {
          return completed(existing);
        }

        let payload: Record<string, unknown>;
        let endpoint: string;

        if (p.kind === 'pull-request') {
          const candidates = await c.discover(p.target, p.sourceRepository, p.headBranch);

          if (candidates.some((pr) => pr.state === 'OPEN')) {
            throw new GhFailure('github_conflict');
          }

          const refs: [string, string, string][] = [
            [p.sourceRepository, p.headBranch, p.headSha],
            [p.target.repository, p.baseBranch, p.baseSha],
          ];

          for (const [repository, branch, sha] of refs) {
            const ref = z
              .object({
                ref: z.string(),
                object: z.object({ type: z.literal('commit'), sha: reviewTargetSchema.shape.sha }),
              })
              .parse(
                await c.session.api(
                  p.target.host,
                  `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
                ),
              );

            if (ref.ref !== `refs/heads/${branch}` || ref.object.sha !== sha) {
              throw new GhFailure('review_target_changed');
            }
          }

          payload = {
            title: p.title,
            body: receiptBody(p, input.marker),
            head: `${p.sourceRepository.split('/')[0]}:${p.headBranch}`,
            head_repo: p.sourceRepository.split('/')[1],
            base: p.baseBranch,
            draft: p.draft,
          };
          endpoint = `repos/${p.target.repository}/pulls`;
        } else {
          const pr = await c.inspect(p.target);

          if (pr.state !== 'OPEN') {
            throw new GhFailure('github_conflict');
          }

          payload =
            p.kind === 'comment'
              ? { body: receiptBody(p, input.marker) }
              : { body: receiptBody(p, input.marker), commit_id: p.target.sha, event: p.event };
          endpoint = `repos/${p.target.repository}/${p.kind === 'comment' ? `issues/${p.target.number}/comments` : `pulls/${p.target.number}/reviews`}`;
        }

        if (!options.artifactParent) {
          throw new GhFailure('github_unavailable');
        }

        const dir = await createPrivateArtifactDirectory(
          options.artifactParent,
          'github-publication',
        );
        const file = await openPrivateArtifact(dir, 'request.json');

        try {
          await file.file.writeFile(JSON.stringify(payload) + '\n');
          await file.file.sync();
        } finally {
          await file.file.close();
        }

        // Keep the private body for host retention/recovery; never put it in argv or logs.
        sent = true;
        await c.session.api(p.target.host, endpoint, 'POST', file.path);
        const receipt = await find(p, input.marker, c);

        if (!receipt) {
          throw new GhFailure('github_invalid_output');
        }

        return completed(receipt);
      } catch (error) {
        const failure = ghFailure(error);

        if (!sent) {
          return failure;
        }

        return {
          schemaVersion: 1,
          outcome: 'uncertain',
          error: {
            code: 'github_write_uncertain',
            message:
              'Publication may have occurred. Reconcile the same saved intent; do not send another write.',
            cause: failure.error.code,
            ...(failure.error.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: failure.error.retryAfterMs }),
          },
        };
      }
    },
  };
}
