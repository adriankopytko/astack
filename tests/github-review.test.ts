import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGhReviewTargetReader,
  processRequestSchema,
  type ProcessRequest,
  type ProcessExecution,
} from '../src/index.js';
import { reviewGateBlocker } from '../src/core/review-gates.js';
import type { ReviewSnapshot } from '../src/contracts/review.js';
const target = {
  host: 'github.com',
  repository: 'example/project',
  number: 12,
  sha: 'a'.repeat(40),
};
const pr = {
  number: 12,
  html_url: 'https://github.com/example/project/pull/12',
  head: { sha: target.sha, ref: 'feature', repo: { full_name: 'contributor/fork' } },
  base: { sha: target.sha, ref: 'main', repo: { full_name: 'example/project' } },
  state: 'open',
  merged_at: null,
  draft: false,
  title: 'Fixture',
  body: null,
  user: { login: 'contributor' },
};
function execution(body: unknown, code = 0): ProcessExecution {
  const output = (text: string) => ({
    text,
    capturedBytes: Buffer.byteLength(text),
    observedBytes: Buffer.byteLength(text),
    complete: true,
    truncated: false,
    artifact: null,
  });

  return {
    schemaVersion: 1,
    outcome: 'exited',
    pid: 123,
    exitCode: code,
    signal: null,
    error: null,
    stdout: output(
      `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
    ),
    stderr: output(''),
    shutdown: { root: 'exited', processGroup: 'absent', termSent: false, killSent: false },
  };
}

function reader(responses: ProcessExecution[]) {
  const calls: ProcessRequest[] = [];
  const provider = createGhReviewTargetReader({
    executable: '/trusted/gh',
    environment: { HOME: '/fixture', GH_TOKEN: 'fixture-secret' },
    now: () => 100,
    runner: {
      async run(request) {
        processRequestSchema.parse(request);
        calls.push(request);
        const response = responses.shift();

        assert.ok(response, 'Unexpected provider call');

        return response;
      },
    },
  });

  return { provider, calls };
}

await test('GitHub wrapper brackets exact base repository and fork head checks with explicit argv and controlled environment', async () => {
  const state = reader([
    execution(pr),
    execution({
      check_runs: [
        { id: 1, head_sha: target.sha, name: 'test', status: 'in_progress', conclusion: null },
      ],
    }),
    execution([]),
    execution(pr),
  ]);
  const result = await state.provider.read({ target, root: '/owned/review' });

  assert.ok(result.outcome === 'completed', JSON.stringify(result));
  assert.equal(result.value.checks[0]?.state, 'pending');
  assert.equal(result.value.sourceRepository, 'contributor/fork');
  assert.equal(state.calls.length, 4);
  assert.deepEqual(state.calls[0]?.args, [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    '--include',
    '--header',
    'Accept: application/vnd.github+json',
    '--header',
    'X-GitHub-Api-Version: 2022-11-28',
    'repos/example/project/pulls/12',
  ]);
  assert.equal(
    state.calls.every((call) => call.cwd === '/owned/review' && !call.args.includes('--watch')),
    true,
  );
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});
await test('GitHub wrapper rejects wrong PR attribution, moving head, ambiguous checks and incomplete subprocess evidence', async () => {
  const cases = [
    [execution({ ...pr, html_url: 'https://github.com/wrong/project/pull/12' })],
    [execution({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } })],
    [
      execution(pr),
      execution({ check_runs: [] }),
      execution([]),
      execution({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }),
    ],
    [
      execution(pr),
      execution({
        check_runs: [
          { id: 1, head_sha: target.sha, name: 'test', status: 'completed', conclusion: 'success' },
          { id: 2, head_sha: target.sha, name: 'test', status: 'completed', conclusion: 'failure' },
        ],
      }),
      execution([]),
      execution(pr),
    ],
    [
      {
        ...execution(pr),
        stdout: {
          text: '{}',
          capturedBytes: 2,
          observedBytes: 2,
          complete: false,
          truncated: false,
          artifact: null,
        },
      },
    ],
    [
      execution(pr),
      execution({
        check_runs: [
          { id: 1, head_sha: target.sha, name: 'test', status: 'completed', conclusion: 'unknown' },
        ],
      }),
    ],
  ] satisfies ProcessExecution[][];

  for (const responses of cases) {
    const state = reader(responses);
    const result = await state.provider.read({ target, root: '/owned/review' });

    assert.equal(result.outcome, 'rejected', JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  }
});
await test('readiness never treats no checks, missing required checks, skipped or cancelled checks as passing', () => {
  const snapshot: ReviewSnapshot = {
    target,
    baseSha: target.sha,
    state: 'OPEN',
    draft: false,
    sourceRepository: null,
    checks: [],
    observedAt: 100,
  };
  const gate = { requiredChecks: [], overrideReason: null };

  assert.equal(reviewGateBlocker(snapshot, gate), 'checks_missing');

  for (const state of ['fail', 'pending', 'skipping', 'cancel'] as const) {
    assert.equal(
      reviewGateBlocker({ ...snapshot, checks: [{ name: 'test', state }] }, gate),
      'checks_not_passing',
    );
  }

  const pass: ReviewSnapshot = { ...snapshot, checks: [{ name: 'test', state: 'pass' }] };

  assert.equal(reviewGateBlocker(pass, gate), null);
  assert.equal(reviewGateBlocker(pass, { ...gate, requiredChecks: ['missing'] }), 'checks_missing');
  assert.equal(
    reviewGateBlocker({ ...pass, draft: true }, { ...gate, overrideReason: 'Early review' }),
    'pr_not_ready',
  );
  assert.equal(reviewGateBlocker({ ...pass, state: 'CLOSED' }, gate), 'pr_not_ready');
});
