import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { completed, rejected } from '../../contracts/operation-result.js';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import { reviewSnapshotSchema, reviewTargetSchema } from '../../contracts/review-task.js';
import type { ReviewTargetReader } from '../../ports/review.js';
import type { ProcessRunner } from '../../ports/process-runner.js';

const prSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().max(1024),
  headRefOid: reviewTargetSchema.shape.sha,
  baseRefOid: reviewTargetSchema.shape.sha,
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRepository: z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).nullable(),
  headRepositoryOwner: z.object({ login: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).nullable(),
});
const checksSchema = z
  .array(
    z.object({
      name: z.string(),
      state: z.string().max(128),
      bucket: z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']),
    }),
  )
  .max(64);

/** Three bounded targeted gh reads; no watch loop, writes, fetches or ambient PR discovery. */
export function createGhReviewTargetReader(input: {
  executable: string;
  runner: ProcessRunner;
  environment: Readonly<Record<string, string>>;
  now: () => number;
}): ReviewTargetReader {
  return {
    async read(request, signal) {
      const invalid = rejected(
        'github_invalid_output',
        'GitHub target/check evidence was incomplete or invalid; no review was launched.',
      );

      try {
        const target = reviewTargetSchema.parse(request.target);

        if (!isAbsolute(input.executable)) {
          return rejected('github_unavailable', 'Select a trusted absolute GitHub CLI executable.');
        }

        async function run(args: string[], codes: number[] = [0]): Promise<unknown> {
          const execution = processResultSchema.parse(
            await input.runner.run(
              processRequestSchema.parse({
                schemaVersion: 1,
                executable: input.executable,
                args,
                cwd: request.root,
                env: {
                  ...input.environment,
                  GH_PROMPT_DISABLED: '1',
                  GH_PAGER: 'cat',
                  NO_COLOR: '1',
                },
                timeoutMs: 10000,
                maxCaptureBytes: 131072,
              }),
              signal,
            ),
          );

          if (
            execution.outcome !== 'exited' ||
            !codes.includes(execution.exitCode ?? -1) ||
            execution.signal !== null ||
            execution.shutdown.processGroup !== 'absent' ||
            !execution.stdout.complete ||
            execution.stdout.truncated ||
            !execution.stderr.complete ||
            execution.stderr.truncated ||
            execution.error !== null
          ) {
            throw new Error('GitHub read not verified');
          }

          return JSON.parse(execution.stdout.text) as unknown;
        }

        const repo = `${target.host}/${target.repository}`;
        const args = [
          'pr',
          'view',
          String(target.number),
          '--repo',
          repo,
          '--json',
          'number,url,headRefOid,baseRefOid,state,isDraft,headRepository,headRepositoryOwner',
        ];
        const before = prSchema.parse(await run(args));
        const expectedUrl = `https://${target.host}/${target.repository}/pull/${target.number}`;

        if (
          before.number !== target.number ||
          before.url.toLowerCase() !== expectedUrl ||
          before.headRefOid !== target.sha
        ) {
          return rejected(
            'review_target_changed',
            'The selected repository/PR no longer identifies the requested full head SHA.',
          );
        }

        const checks = checksSchema.parse(
          await run(
            ['pr', 'checks', String(target.number), '--repo', repo, '--json', 'name,state,bucket'],
            [0, 1, 8],
          ),
        );
        const after = prSchema.parse(await run(args));

        if (JSON.stringify(before) !== JSON.stringify(after)) {
          return rejected(
            'review_target_changed',
            'PR identity or readiness changed during the check read; inspect and retry explicitly.',
          );
        }

        const value = reviewSnapshotSchema.safeParse({
          target,
          baseSha: before.baseRefOid,
          state: before.state,
          draft: before.isDraft,
          sourceRepository:
            before.headRepository && before.headRepositoryOwner
              ? `${before.headRepositoryOwner.login}/${before.headRepository.name}`
              : null,
          checks: checks
            .map((c) => ({ name: c.name, state: c.bucket }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          observedAt: input.now(),
        });

        return value.success ? completed(value.data) : invalid;
      } catch {
        return signal?.aborted
          ? rejected('cancelled', 'GitHub target inspection was cancelled.')
          : invalid;
      }
    },
  };
}
