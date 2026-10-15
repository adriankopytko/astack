import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applicationInfoResultSchema,
  checkoutRecordSchema,
  getApplicationInfo,
  projectContextResultSchema,
  projectContextSchema,
  projectRecordSchema,
  resolveProjectContext,
  type OperationResult,
  type ProjectContextReader,
} from '../src/index.js';

const project = projectRecordSchema.parse({ id: 'project-a', primaryCheckoutId: 'checkout-main' });
const checkout = checkoutRecordSchema.parse({
  id: 'checkout-main',
  projectId: project.id,
  repositoryId: 'repository-a',
  rootPath: '/work/project-a',
  gitCommonDirectory: '/work/project-a/.git',
});
const request = { schemaVersion: 1, projectId: project.id };

function reader(overrides: Partial<ProjectContextReader> = {}): ProjectContextReader {
  return {
    readProject: () => Promise.resolve(project),
    readCheckout: () => Promise.resolve(checkout),
    ...overrides,
  };
}

function assertRejected(result: OperationResult<unknown>, code: string) {
  assert.equal(result.schemaVersion, 1);

  if (result.outcome !== 'rejected') {
    assert.fail('Expected a rejected operation');
  }

  assert.equal(result.error.code, code);
  assert.equal('value' in result, false);
}

await test('package inspection consumes versioned input and returns a completed result', () => {
  const result = applicationInfoResultSchema.parse(
    getApplicationInfo({ schemaVersion: 1 }, '0.1.0'),
  );

  assert.deepEqual(result, {
    schemaVersion: 1,
    outcome: 'completed',
    value: { name: 'astack', version: '0.1.0', stage: 'foundation' },
  });
});

await test('malformed and unsupported requests are distinct and do not read context sources', async () => {
  let calls = 0;
  const source = reader({
    readProject: () => {
      calls++;

      return Promise.resolve(project);
    },
  });

  for (const input of [
    null,
    {},
    { schemaVersion: '1' },
    { ...request, schemaVersion: 0 },
    { ...request, projectId: '' },
    { ...request, secret: 'private-value' },
  ]) {
    const result = await resolveProjectContext(input, source);
    assertRejected(result, 'invalid_request');

    assert.doesNotMatch(JSON.stringify(result), /private-value/);
  }

  assertRejected(
    await resolveProjectContext({ ...request, schemaVersion: 2 }, source),
    'unsupported_contract_version',
  );
  assertRejected(getApplicationInfo({ schemaVersion: 2 }, '0.1.0'), 'unsupported_contract_version');
  assertRejected(getApplicationInfo({ schemaVersion: 1, extra: true }, '0.1.0'), 'invalid_request');

  assert.equal(calls, 0);
});

await test('the result decoder rejects unsupported versions, extra data, and invented completion', () => {
  for (const result of [
    {
      schemaVersion: 2,
      outcome: 'completed',
      value: { name: 'astack', version: '0.1.0', stage: 'foundation' },
    },
    { schemaVersion: 1, outcome: 'completed' },
    { schemaVersion: 1, outcome: 'accepted', jobId: 'job-a' },
    { schemaVersion: 1, outcome: 'rejected', error: { code: 'anything', message: 'No' } },
    {
      schemaVersion: 1,
      outcome: 'rejected',
      error: { code: 'invalid_request', message: 'No', secret: 'hidden' },
    },
    { ...getApplicationInfo({ schemaVersion: 1 }, '0.1.0'), debug: 'extra' },
  ]) {
    assert.equal(applicationInfoResultSchema.safeParse(result).success, false);
  }
});

await test('explicit project resolution uses saved primary identity and ignores ambient cwd', async () => {
  const calls: string[] = [];
  const result = projectContextResultSchema.parse(
    await resolveProjectContext(
      request,
      reader({
        readProject: (id) => {
          calls.push(id);

          return Promise.resolve(project);
        },
        readCheckout: (id) => {
          calls.push(id);

          return Promise.resolve(checkout);
        },
      }),
    ),
  );

  assert.deepEqual(calls, [project.id, checkout.id]);
  assert.deepEqual(result, {
    schemaVersion: 1,
    outcome: 'completed',
    value: { project, checkout, selection: 'primary-checkout' },
  });
});

await test('linked checkouts and independent clones retain distinct local identities', async () => {
  for (const candidate of [
    { ...checkout, id: 'checkout-linked', rootPath: '/work/linked' },
    {
      ...checkout,
      id: 'checkout-clone',
      rootPath: '/work/clone',
      repositoryId: 'repository-clone',
      gitCommonDirectory: '/work/clone/.git',
    },
  ]) {
    const result = await resolveProjectContext(
      { ...request, checkoutId: candidate.id },
      reader({ readCheckout: () => Promise.resolve(candidate) }),
    );

    if (result.outcome !== 'completed') {
      assert.fail('Explicit registered checkout should resolve');
    }

    assert.equal(result.value.selection, 'explicit-checkout');
    assert.deepEqual(result.value.checkout, candidate);
  }
});

await test('missing records, conflicting ownership, and corrupt source data do not resolve', async () => {
  const scenarios: [Partial<ProjectContextReader>, string][] = [
    [{ readProject: () => Promise.resolve(null) }, 'project_not_found'],
    [{ readCheckout: () => Promise.resolve(null) }, 'checkout_not_found'],
    [
      { readProject: () => Promise.resolve({ ...project, id: 'project-other' }) },
      'invalid_context_source',
    ],
    [
      { readCheckout: () => Promise.resolve({ ...checkout, id: 'checkout-other' }) },
      'invalid_context_source',
    ],
    [
      { readCheckout: () => Promise.resolve({ ...checkout, projectId: 'project-other' }) },
      'checkout_project_mismatch',
    ],
    [
      { readCheckout: () => Promise.resolve({ ...checkout, rootPath: 'relative' }) },
      'invalid_context_source',
    ],
    [{ readProject: () => Promise.resolve(undefined) }, 'invalid_context_source'],
    [
      { readCheckout: () => Promise.resolve({ ...checkout, credentials: 'private-value' }) },
      'invalid_context_source',
    ],
    [
      { readProject: () => Promise.reject(new Error('private-value')) },
      'context_source_unavailable',
    ],
    [
      { readCheckout: () => Promise.reject(new Error('private-value')) },
      'context_source_unavailable',
    ],
  ];

  for (const [overrides, code] of scenarios) {
    const result = await resolveProjectContext(request, reader(overrides));
    assertRejected(result, code);

    assert.doesNotMatch(JSON.stringify(result), /private-value|credentials/);
  }
});

await test('context decoding rejects cross-project and false-primary evidence', () => {
  assert.equal(
    projectContextSchema.safeParse({
      project,
      checkout: { ...checkout, projectId: 'other' },
      selection: 'primary-checkout',
    }).success,
    false,
  );
  assert.equal(
    projectContextSchema.safeParse({
      project,
      checkout: { ...checkout, id: 'other' },
      selection: 'primary-checkout',
    }).success,
    false,
  );
  assert.equal(
    checkoutRecordSchema.safeParse({ ...checkout, rootPath: '/work/invalid\0path' }).success,
    false,
  );
});

await test('an already cancelled read performs no source calls', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await resolveProjectContext(
    request,
    reader({
      readProject: () => {
        calls++;

        return Promise.resolve(project);
      },
    }),
    controller.signal,
  );
  assertRejected(result, 'cancelled');

  assert.equal(calls, 0);
});

await test('cancellation between reads prevents checkout lookup', async () => {
  const controller = new AbortController();
  let checkoutCalls = 0;
  const result = await resolveProjectContext(
    request,
    reader({
      readProject: (_id, signal) => {
        assert.equal(signal, controller.signal);

        controller.abort();

        return Promise.resolve(project);
      },
      readCheckout: () => {
        checkoutCalls++;

        return Promise.resolve(checkout);
      },
    }),
    controller.signal,
  );
  assertRejected(result, 'cancelled');

  assert.equal(checkoutCalls, 0);
});

await test('cancellation during checkout lookup cannot report completion', async () => {
  const controller = new AbortController();
  const result = await resolveProjectContext(
    request,
    reader({
      readCheckout: () => {
        controller.abort();

        return Promise.resolve(checkout);
      },
    }),
    controller.signal,
  );
  assertRejected(result, 'cancelled');
});

await test('aborted source errors stay cancelled and read-only retries re-observe facts', async () => {
  const controller = new AbortController();
  assertRejected(
    await resolveProjectContext(
      request,
      reader({
        readProject: () => {
          controller.abort();

          return Promise.reject(new Error('private-value'));
        },
      }),
      controller.signal,
    ),
    'cancelled',
  );
  let attempts = 0;
  const source = reader({
    readProject: () => {
      attempts++;

      return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(project);
    },
  });
  assertRejected(await resolveProjectContext(request, source), 'context_source_unavailable');
  const retried = await resolveProjectContext(request, source);

  assert.equal(retried.outcome, 'completed');
  assert.equal(attempts, 2);
});
