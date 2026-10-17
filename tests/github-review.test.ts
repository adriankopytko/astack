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
  url: 'https://github.com/example/project/pull/12',
  headRefOid: target.sha,
  baseRefOid: target.sha,
  state: 'OPEN',
  isDraft: false,
  headRepository: { name: 'fork' },
  headRepositoryOwner: { login: 'contributor' },
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
    stdout: output(JSON.stringify(body)),
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
    execution([{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }], 8),
    execution(pr),
  ]);
  const result = await state.provider.read({ target, root: '/owned/review' });

  assert.ok(result.outcome === 'completed', JSON.stringify(result));
  assert.equal(result.value.checks[0]?.state, 'pending');
  assert.equal(result.value.sourceRepository, 'contributor/fork');
  assert.equal(state.calls.length, 3);
  assert.deepEqual(state.calls[0]?.args, [
    'pr',
    'view',
    '12',
    '--repo',
    'github.com/example/project',
    '--json',
    'number,url,headRefOid,baseRefOid,state,isDraft,headRepository,headRepositoryOwner',
  ]);
  assert.equal(
    state.calls.every((call) => call.cwd === '/owned/review' && !call.args.includes('--watch')),
    true,
  );
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});
await test('GitHub wrapper rejects wrong PR attribution, moving head, ambiguous checks and incomplete subprocess evidence', async () => {
  const cases = [
    [execution({ ...pr, url: 'https://github.com/wrong/project/pull/12' })],
    [execution({ ...pr, headRefOid: 'b'.repeat(40) })],
    [execution(pr), execution([]), execution({ ...pr, headRefOid: 'b'.repeat(40) })],
    [
      execution(pr),
      execution([
        { name: 'test', state: 'SUCCESS', bucket: 'pass' },
        { name: 'test', state: 'FAILURE', bucket: 'fail' },
      ]),
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
    [execution(pr), execution([{ name: 'test', state: 'SUCCESS', bucket: 'unknown' }])],
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
