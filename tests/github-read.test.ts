import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGhReadPrimitives } from '../src/adapters/github/read.js';
import { http, pull, target } from './support/github.js';

await test('targeted issue and PR reads share fresh snapshots and coalesce simultaneous requests', async () => {
  let now = 1000;
  let calls = 0;
  const reader = createGhReadPrimitives({
    executable: '/trusted/gh',
    environment: {},
    now: () => now,
    runner: {
      async run(request) {
        calls++;
        const endpoint = request.args.at(-1) ?? '';
        await new Promise((resolve) => setTimeout(resolve, 10));

        return endpoint.includes('/issues/')
          ? http({
              number: 12,
              html_url: 'https://github.com/example/project/issues/12',
              title: 'Task',
              body: 'Details',
              state: 'open',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'author' },
            })
          : http(pull());
      },
    },
  });
  const request = {
    repository: { host: target.host, repository: target.repository },
    number: 12,
    root: '/project',
    maxAgeMs: 1000,
  };
  const [first, second] = await Promise.all([reader.issue(request), reader.issue(request)]);

  assert.equal(first.outcome, 'completed');
  assert.equal(second.outcome, 'completed');
  assert.equal(calls, 1);

  if (first.outcome === 'completed') {
    first.value.value.title = 'local edit';
  }

  now += 500;
  const cached = await reader.issue(request);

  assert.ok(cached.outcome === 'completed' && cached.value.cached);
  assert.equal(cached.value.value.title, 'Task');
  assert.equal(calls, 1);

  now += 501;
  await reader.issue(request);
  const pr = await reader.pullRequest(request);

  assert.ok(pr.outcome === 'completed');
  assert.equal(calls, 3);
});

await test('failed and incorrectly attributed issue reads are not cached', async () => {
  let calls = 0;
  const reader = createGhReadPrimitives({
    executable: '/trusted/gh',
    environment: {},
    now: () => 1000,
    runner: {
      async run() {
        calls++;

        return calls === 1
          ? http({ message: 'not found' }, 404)
          : http({
              number: 12,
              html_url: 'https://github.com/other/project/issues/12',
              title: 'Wrong',
              body: '',
              state: 'open',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'author' },
            });
      },
    },
  });
  const request = {
    repository: { host: target.host, repository: target.repository },
    number: 12,
    root: '/project',
    maxAgeMs: 1000,
  };

  assert.equal((await reader.issue(request)).outcome, 'rejected');
  assert.equal((await reader.issue(request)).outcome, 'rejected');
  assert.equal(calls, 2);
});
