import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubPublicationSchema, type ProcessExecution } from '../src/index.js';
import {
  baseSha,
  fixtureProvider,
  http,
  marker,
  publication,
  pull,
  queuedProvider,
  remoteFixture,
  target,
  timedOut,
} from './support/github.js';

async function temporary(check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'astack-github-'));

  try {
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test('GitHub discovery consumes multiple explicit pages and rejects caps, duplicate IDs and foreign attribution', async () => {
  const page = Array.from({ length: 100 }, (_, i) => pull(i + 1));
  const input = {
    repository: { host: target.host, repository: target.repository },
    sourceRepository: 'contributor/fork',
    headBranch: 'feature/nested',
    root: '/owned/root',
  };
  const state = queuedProvider([http(page), http([pull(101)])]);
  const result = await state.provider.discoverPullRequests(input);

  assert.ok(result.outcome === 'completed');
  assert.equal(result.value.length, 101);
  assert.match(state.calls[0]?.args.at(-1) ?? '', /head=contributor%3Afeature%2Fnested/);
  assert.match(state.calls[1]?.args.at(-1) ?? '', /page=2$/);
  assert.ok(
    state.calls.every((call) => call.cwd === input.root && !call.args.includes('--paginate')),
  );

  for (const [replies, maxPages, code] of [
    [[http(page)], 1, 'github_limit_exceeded'],
    [[http(page), http([pull(1)])], 2, 'github_invalid_output'],
    [
      [http([{ ...pull(), head: { ...pull().head, repo: { full_name: 'wrong/fork' } } }])],
      2,
      'github_invalid_output',
    ],
    [
      [http([{ ...pull(), html_url: 'https://evil.invalid/example/project/pull/12' }])],
      2,
      'github_invalid_output',
    ],
  ] as const) {
    const fixture = queuedProvider([...replies], { maxPages });
    const failure = await fixture.provider.discoverPullRequests(input);

    assert.equal(failure.outcome, 'rejected');
    assert.ok(failure.outcome === 'rejected' && failure.error.code === code);
    assert.equal(fixture.calls.length, replies.length);
  }
});

await test('GitHub checks paginate statuses, use latest contexts, preserve conclusions and bind the exact SHA', async () => {
  const statuses = Array.from({ length: 100 }, (_, i) => ({
    id: i + 2,
    context: 'legacy-test',
    state: 'success',
  }));
  const state = queuedProvider([
    http(pull()),
    http({
      check_runs: [
        {
          id: 1,
          head_sha: target.sha,
          name: 'neutral',
          status: 'completed',
          conclusion: 'neutral',
        },
        {
          id: 2,
          head_sha: target.sha,
          name: 'cancelled',
          status: 'completed',
          conclusion: 'cancelled',
        },
        { id: 3, head_sha: target.sha, name: 'queued', status: 'queued', conclusion: null },
      ],
    }),
    http(statuses),
    http([{ id: 1, context: 'legacy-test', state: 'failure' }]),
    http(pull()),
  ]);
  const result = await state.provider.readChecks({ target, root: '/owned/root' });

  assert.ok(result.outcome === 'completed', JSON.stringify(result));
  assert.deepEqual(
    Object.fromEntries(result.value.checks.map((check) => [check.name, check.state])),
    { cancelled: 'cancel', 'legacy-test': 'pass', neutral: 'skipping', queued: 'pending' },
  );
  assert.equal(result.value.baseSha, baseSha);
  assert.equal(state.calls.length, 5);
  assert.ok(
    state.calls.slice(1, 4).every((call) => call.args.at(-1)?.includes(`/commits/${target.sha}/`)),
  );
});

await test('GitHub rejects incomplete check evidence and changing base, PR number or head', async () => {
  for (const replies of [
    [http(pull(13))],
    [
      http(pull()),
      http({
        check_runs: [
          {
            id: 1,
            head_sha: 'd'.repeat(40),
            name: 'wrong',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      }),
      http([]),
    ],
    [
      http(pull()),
      http({ check_runs: [] }),
      http([]),
      http({ ...pull(), base: { ...pull().base, sha: 'd'.repeat(40) } }),
    ],
    [
      http(pull()),
      http({ check_runs: [] }),
      http([
        { id: 1, context: 'same', state: 'success' },
        { id: 1, context: 'same', state: 'failure' },
      ]),
    ],
  ]) {
    const state = queuedProvider(replies);
    const result = await state.provider.readChecks({ target, root: '/owned/root' });

    assert.equal(result.outcome, 'rejected', JSON.stringify(result));
  }
});

await test('GitHub classifies HTTP errors and numeric retry hints without retrying or leaking diagnostics', async () => {
  for (const [status, headers, message, code, retry] of [
    [401, {}, 'fixture-secret', 'github_auth_required', undefined],
    [403, {}, 'fixture-secret', 'github_forbidden', undefined],
    [404, {}, 'fixture-secret', 'github_not_found', undefined],
    [422, {}, 'fixture-secret', 'github_conflict', undefined],
    [500, {}, 'fixture-secret', 'github_failed', undefined],
    [429, { 'Retry-After': '2' }, 'fixture-secret', 'github_rate_limited', 2000],
    [
      403,
      { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '3' },
      'fixture-secret',
      'github_rate_limited',
      2000,
    ],
    [
      403,
      {},
      'You have exceeded a secondary rate limit: fixture-secret',
      'github_rate_limited',
      undefined,
    ],
  ] as const) {
    const state = queuedProvider([http({ message }, status, headers)]);
    const result = await state.provider.inspectPullRequest({ target, root: '/owned/root' });

    assert.ok(result.outcome === 'rejected');
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryAfterMs, retry);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0]?.env.GH_DEBUG, '');
    assert.equal(state.calls[0]?.env.GH_FORCE_TTY, '');
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  }
});

await test('GitHub enforces an aggregate deadline and cancellation before further reads', async () => {
  let now = 1000;
  const state = fixtureProvider(
    () => {
      now = 1100;

      return http(pull());
    },
    { now: () => now, timeoutMs: 100 },
  );
  const result = await state.provider.readChecks({ target, root: '/owned/root' });

  assert.ok(result.outcome === 'rejected');
  assert.equal(result.error.code, 'github_timed_out');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]?.timeoutMs, 100);

  const controller = new AbortController();
  controller.abort();
  const cancelled = queuedProvider([]);
  const stopped = await cancelled.provider.inspectPullRequest(
    { target, root: '/owned/root' },
    controller.signal,
  );

  assert.ok(stopped.outcome === 'rejected');
  assert.equal(stopped.error.code, 'cancelled');
  assert.equal(cancelled.calls.length, 0);
});

await test('GitHub rejects nonzero success, partial capture, remaining descendants and malformed JSON', async () => {
  const good = http(pull());
  const invalid: ProcessExecution[] = [
    http(pull(), 200, {}, 1),
    { ...good, stdout: { ...good.stdout, complete: false } },
    { ...good, shutdown: { ...good.shutdown, processGroup: 'present' } },
    {
      ...good,
      stdout: { ...good.stdout, text: '{}', capturedBytes: 2, observedBytes: 3, truncated: true },
    },
    http('not a PR'),
    timedOut(),
  ];

  for (const response of invalid) {
    const state = queuedProvider([response]);
    const result = await state.provider.inspectPullRequest({ target, root: '/owned/root' });

    assert.equal(result.outcome, 'rejected');
    assert.equal(state.calls.length, 1);
  }
});

for (const kind of ['pull-request', 'comment', 'review'] as const) {
  await test(`GitHub ${kind} publication sends a private multiline JSON body once and recovers existing evidence`, async () => {
    await temporary(async (directory) => {
      const p = publication(kind);
      const state = remoteFixture(p, directory);
      const input = { publication: p, marker, root: directory };
      const result = await state.provider.publish(input);

      assert.ok(result.outcome === 'completed', JSON.stringify(result));
      assert.equal(state.posts, 1);
      assert.equal(state.payloads[0]?.body, `${p.body}\n\n${marker}`);
      assert.equal(result.value.target.sha, target.sha);
      assert.equal(result.value.marker, marker);

      if (kind === 'review') {
        assert.equal(state.payloads[0]?.commit_id, target.sha);
        assert.equal(state.payloads[0]?.event, 'REQUEST_CHANGES');
      }

      if (kind === 'pull-request') {
        assert.equal(state.payloads[0]?.head, 'contributor:feature/nested');
        assert.equal(state.payloads[0]?.head_repo, 'fork');
        assert.equal(state.payloads[0]?.draft, true);
      }

      const duplicate = await state.provider.publish(input);

      assert.equal(duplicate.outcome, 'completed');
      assert.equal(state.posts, 1);
    });
  });

  await test(`GitHub ${kind} timeout after remote acceptance reconciles without another POST`, async () => {
    await temporary(async (directory) => {
      const p = publication(kind);
      const state = remoteFixture(p, directory);
      state.postResult = timedOut();
      const input = { publication: p, marker, root: directory };
      const result = await state.provider.publish(input);

      assert.ok(result.outcome === 'uncertain');
      assert.equal(result.error.cause, 'github_timed_out');
      assert.equal(state.posts, 1);

      const recovered = await state.provider.findPublication(input);

      assert.equal(recovered.outcome, 'completed');
      assert.ok(recovered.outcome === 'completed' && recovered.value);
      assert.equal(state.posts, 1);
    });
  });
}

await test('GitHub refuses wrong actors and stale heads before attempting a publication', async () => {
  await temporary(async (directory) => {
    for (const kind of ['pull-request', 'comment', 'review'] as const) {
      const p = publication(kind);
      const state = remoteFixture(p, directory);
      state.actor = 'wrong-actor';
      const wrongActor = await state.provider.publish({ publication: p, marker, root: directory });

      assert.ok(wrongActor.outcome === 'rejected');
      assert.equal(wrongActor.error.code, 'github_auth_required');
      assert.equal(state.posts, 0);

      state.actor = p.actor;
      state.head = 'd'.repeat(40);
      const stale = await state.provider.publish({ publication: p, marker, root: directory });

      assert.ok(stale.outcome === 'rejected');
      assert.equal(stale.error.code, 'review_target_changed');
      assert.equal(state.posts, 0);
    }
  });
});

await test('GitHub preserves conflicts, edited bodies, duplicate markers and wrong review commit/action', async () => {
  await temporary(async (directory) => {
    const p = publication('review');
    const state = remoteFixture(p, directory);
    const input = { publication: p, marker, root: directory };
    await state.provider.publish(input);
    const original = state.records[0] as Record<string, unknown>;

    for (const records of [
      [
        original,
        {
          ...original,
          id: 100,
          html_url: 'https://github.com/example/project/pull/12#pullrequestreview-100',
        },
      ],
      [{ ...original, body: `${p.body}\n\n${marker}\nedited` }],
      [{ ...original, user: { login: 'wrong-actor' } }],
      [{ ...original, commit_id: 'd'.repeat(40) }],
      [{ ...original, state: 'APPROVED' }],
      [{ ...original, pull_request_url: 'https://api.github.com/repos/wrong/project/pulls/12' }],
    ]) {
      state.records = records;
      const result = await state.provider.findPublication(input);

      assert.ok(result.outcome === 'rejected');
      assert.equal(result.error.code, 'github_conflict');
      assert.equal(state.posts, 1);
    }
  });
});

await test('GitHub validates publication requests without starting a process', async () => {
  const p = publication('comment');

  for (const invalid of [
    { ...p, body: '<!-- astack:fake -->' },
    { ...p, body: '\0' },
    { ...p, body: '💡'.repeat(3000) },
    { ...p, target: { ...p.target, sha: 'abc123' } },
  ]) {
    assert.equal(githubPublicationSchema.safeParse(invalid).success, false);
  }

  const state = queuedProvider([]);
  const result = await state.provider.publish({
    publication: p,
    marker: 'invalid',
    root: '/owned/root',
  });

  assert.equal(result.outcome, 'rejected');
  assert.equal(state.calls.length, 0);
});

await test('GitHub HTTP parsing accepts LF, CRLF and a valid headerless JSON response', async () => {
  for (const headers of [
    'Content-Type: application/json\n\n',
    '\n',
    'Content-Type: application/json\r\n\r\n',
  ]) {
    const text = `HTTP/2.0 200 OK\n${headers}${JSON.stringify(pull())}`;
    const response = http(null);
    response.stdout = {
      ...response.stdout,
      text,
      capturedBytes: Buffer.byteLength(text),
      observedBytes: Buffer.byteLength(text),
    };
    const state = queuedProvider([response]);
    const result = await state.provider.inspectPullRequest({ target, root: '/owned/root' });

    assert.equal(result.outcome, 'completed', JSON.stringify(result));
  }
});

await test('GitHub searches later comment/review pages and recovers historical SHA evidence after head advances', async () => {
  await temporary(async (directory) => {
    for (const kind of ['comment', 'review'] as const) {
      const p = publication(kind);
      const state = remoteFixture(p, directory);
      const input = { publication: p, marker, root: directory };
      const result = await state.provider.publish(input);

      assert.equal(result.outcome, 'completed');

      const original = state.records[0] as Record<string, unknown>;
      const unrelated = Array.from({ length: 100 }, (_, index) => ({
        ...original,
        id: index + 1,
        body: null,
        user: null,
        ...(kind === 'review' ? { commit_id: null, state: 'PENDING' } : {}),
      }));
      state.records = [
        ...unrelated,
        {
          ...original,
          id: 1000,
          html_url: `https://github.com/example/project/pull/12#${kind === 'comment' ? 'issuecomment-' : 'pullrequestreview-'}1000`,
        },
      ];
      state.head = 'd'.repeat(40);
      const before = state.calls.length;
      const recovered = await state.provider.findPublication(input);

      assert.ok(recovered.outcome === 'completed' && recovered.value);
      assert.equal(recovered.value.id, 1000);
      assert.equal(recovered.value.target.sha, target.sha);
      assert.equal(state.calls.length - before, 2);
      assert.equal(state.posts, 1);
    }
  });
});

await test('GitHub refuses an unowned open PR and conflicts in existing PR publication evidence', async () => {
  await temporary(async (directory) => {
    const p = publication('pull-request');
    const state = remoteFixture(p, directory);
    const input = { publication: p, marker, root: directory };
    state.records = [pull()];
    const unowned = await state.provider.publish(input);

    assert.ok(unowned.outcome === 'rejected' && unowned.error.code === 'github_conflict');
    assert.equal(state.posts, 0);

    state.records = [];
    const created = await state.provider.publish(input);

    assert.equal(created.outcome, 'completed');

    const original = state.records[0] as Record<string, unknown>;

    for (const changed of [
      { ...original, draft: false },
      { ...original, title: 'Edited title' },
      { ...original, base: { ...pull().base, sha: 'd'.repeat(40) } },
      { ...original, body: `edited\n${p.body}\n\n${marker}` },
    ]) {
      state.records = [changed];
      const result = await state.provider.findPublication(input);

      assert.ok(result.outcome === 'rejected' && result.error.code === 'github_conflict');
      assert.equal(state.posts, 1);
    }
  });
});

await test('GitHub reports malformed JSON and rejects invalid transport budgets before execution', async () => {
  const text = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"broken"';
  const response = http(null);
  response.stdout = {
    ...response.stdout,
    text,
    capturedBytes: Buffer.byteLength(text),
    observedBytes: Buffer.byteLength(text),
  };
  const malformed = queuedProvider([response]);
  const result = await malformed.provider.inspectPullRequest({ target, root: '/owned/root' });

  assert.ok(result.outcome === 'rejected' && result.error.code === 'github_invalid_output');

  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 300001 },
    { maxPages: 0 },
    { maxPages: 101 },
    { executable: 'gh' },
  ]) {
    const state = queuedProvider([], options);
    const invalid = await state.provider.inspectPullRequest({ target, root: '/owned/root' });

    assert.ok(invalid.outcome === 'rejected' && invalid.error.code === 'github_unavailable');
    assert.equal(state.calls.length, 0);
  }
});
