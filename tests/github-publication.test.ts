import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acceptStateJob,
  openSqliteState,
  prepareStateAttempt,
  publishGithubEffect,
  saveStateProject,
  type GithubProvider,
  type GithubPublication,
  type StateStore,
  type StateEffect,
  type StateWriteResult,
} from '../src/index.js';
import { http, publication, remoteFixture, target, timedOut } from './support/github.js';

function persisted<T>(result: StateWriteResult<T>): T {
  assert.ok(result.outcome === 'persisted', JSON.stringify(result));

  return result.value;
}

async function fixture(
  p: GithubPublication,
  check: (context: {
    store: StateStore;
    directory: string;
    root: string;
    reopen: () => Promise<void>;
    openSibling: () => Promise<StateStore>;
    advance: () => void;
    nextId: () => string;
  }) => Promise<void>,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'astack github state ')));
  const root = join(directory, 'checkout');
  await mkdir(root);
  let time = 1000;
  let sequence = 0;
  const open = async () => {
    const opened = await openSqliteState(
      { schemaVersion: 1, stateDirectory: join(directory, 'state') },
      { now: () => time },
    );

    assert.equal(opened.outcome, 'opened', JSON.stringify(opened));
    assert.ok(opened.outcome === 'opened');

    return opened.store;
  };

  let store = await open();

  try {
    persisted(
      saveStateProject(
        {
          schemaVersion: 1,
          repository: {
            id: 'repository',
            commonDirectory: join(root, '.git'),
            objectFormat: 'sha1',
          },
          project: { id: 'project', primaryCheckoutId: 'checkout' },
          checkout: {
            id: 'checkout',
            projectId: 'project',
            repositoryId: 'repository',
            rootPath: root,
            gitCommonDirectory: join(root, '.git'),
          },
        },
        store,
      ),
    );
    persisted(
      acceptStateJob(
        {
          schemaVersion: 1,
          job: {
            id: 'publication-job',
            projectId: 'project',
            repositoryId: 'repository',
            checkoutId: 'checkout',
            requester: 'host',
            operation: 'github-publication',
            idempotencyKey: 'publish-result',
            createdAt: time,
            intent: {},
          },
        },
        store,
      ),
    );
    persisted(
      prepareStateAttempt(
        {
          schemaVersion: 1,
          attempt: {
            id: 'publication-attempt',
            jobId: 'publication-job',
            number: 1,
            branch: 'refs/heads/feature',
            commit: target.sha,
            createdAt: time,
          },
          effects: [
            {
              id: 'publication-effect',
              attemptId: 'publication-attempt',
              kind: 'github-publication:v1',
              key: 'publish-result',
              createdAt: time,
              payload: { publication: { ...p } },
            },
          ],
        },
        store,
      ),
    );
    await check({
      get store() {
        return store;
      },
      directory,
      root,
      openSibling: open,
      async reopen() {
        store.close();
        store = await open();
      },
      advance() {
        time += 100000;
      },
      nextId: () => `publisher-${++sequence}`,
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function request(
  root: string,
  mode: 'publish' | 'reconcile' = 'publish',
  originalWriterStopped = false,
) {
  return { schemaVersion: 1, effectId: 'publication-effect', root, mode, originalWriterStopped };
}

function effect(store: StateStore): StateEffect {
  const result = store.inspectRecord({
    schemaVersion: 1,
    entity: 'effect',
    id: 'publication-effect',
  });

  assert.ok(result.outcome === 'completed' && result.value?.entity === 'effect');

  return result.value.record;
}

for (const kind of ['pull-request', 'comment', 'review'] as const) {
  await test(`journal confirms ${kind}, reopens SQLite and returns the exact saved receipt without provider calls`, async () => {
    const p = publication(kind);
    await fixture(p, async (context) => {
      const remote = remoteFixture(p, context.directory);
      const first = persisted(
        await publishGithubEffect(request(context.root), {
          store: context.store,
          provider: remote.provider,
          nextId: context.nextId,
        }),
      );

      assert.equal(first.state, 'confirmed');
      assert.equal(remote.posts, 1);
      assert.equal(first.evidence?.kind, 'github-publication:v1');
      assert.ok(first.claim);

      await context.reopen();
      const calls = remote.calls.length;
      const repeated = persisted(
        await publishGithubEffect(request(context.root), {
          store: context.store,
          provider: remote.provider,
          nextId: context.nextId,
        }),
      );

      assert.deepEqual(repeated, first);
      assert.equal(remote.calls.length, calls);
      assert.equal(remote.posts, 1);
    });
  });

  await test(`journal preserves uncertain ${kind} through restart and expiry, then reconciles only matching remote evidence`, async () => {
    const p = publication(kind);
    await fixture(p, async (context) => {
      const remote = remoteFixture(p, context.directory);
      remote.postResult = timedOut();
      const first = persisted(
        await publishGithubEffect(request(context.root), {
          store: context.store,
          provider: remote.provider,
          nextId: context.nextId,
        }),
      );

      assert.equal(first.state, 'unknown');
      assert.equal(first.evidence?.cause, 'github_timed_out');
      assert.equal(remote.posts, 1);

      context.advance();
      await context.reopen();
      const calls = remote.calls.length;
      const retry = await publishGithubEffect(request(context.root), {
        store: context.store,
        provider: remote.provider,
        nextId: context.nextId,
      });
      const unattested = await publishGithubEffect(request(context.root, 'reconcile'), {
        store: context.store,
        provider: remote.provider,
        nextId: context.nextId,
      });

      assert.ok(
        retry.outcome === 'rejected' && retry.error.code === 'state_reconciliation_required',
      );
      assert.ok(
        unattested.outcome === 'rejected' &&
          unattested.error.code === 'state_reconciliation_required',
      );
      assert.equal(remote.calls.length, calls);

      const recovered = persisted(
        await publishGithubEffect(request(context.root, 'reconcile', true), {
          store: context.store,
          provider: remote.provider,
          nextId: context.nextId,
        }),
      );

      assert.equal(recovered.state, 'confirmed');
      assert.deepEqual(recovered.claim, first.claim);
      assert.equal(recovered.evidence?.originalWriterStopped, true);
      assert.equal(recovered.evidence?.source, 'host-reconciliation');
      assert.equal(remote.posts, 1);
    });
  });
}

await test('journal retains missing, conflicting and incomplete reconciliation evidence without resending', async () => {
  const p = publication('review');
  await fixture(p, async (context) => {
    const remote = remoteFixture(p, context.directory);
    remote.postResult = timedOut();
    persisted(
      await publishGithubEffect(request(context.root), {
        store: context.store,
        provider: remote.provider,
        nextId: context.nextId,
      }),
    );
    remote.records = [];
    const absent = persisted(
      await publishGithubEffect(request(context.root, 'reconcile', true), {
        store: context.store,
        provider: remote.provider,
        nextId: context.nextId,
      }),
    );

    assert.equal(absent.state, 'unknown');
    assert.equal(absent.evidence?.receipt, null);
    assert.equal(remote.posts, 1);

    const errorProvider: GithubProvider = {
      ...remote.provider,
      async findPublication() {
        return {
          schemaVersion: 1,
          outcome: 'rejected',
          error: { code: 'github_rate_limited', message: 'Fixture', retryAfterMs: 2500 },
        };
      },
    };
    const blocked = persisted(
      await publishGithubEffect(request(context.root, 'reconcile', true), {
        store: context.store,
        provider: errorProvider,
        nextId: context.nextId,
      }),
    );

    assert.equal(blocked.state, 'unknown');
    assert.equal(blocked.evidence?.retryAfterMs, 2500);
    assert.equal(remote.posts, 1);
  });
});

await test('journal allows only one provider execution across two competing controllers', async () => {
  const p = publication('comment');
  await fixture(p, async (context) => {
    const remote = remoteFixture(p, context.directory);
    let release: () => void = () => assert.fail('Provider was not entered');
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};

    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sends = 0;
    const provider: GithubProvider = {
      ...remote.provider,
      async publish(input, signal) {
        sends++;

        assert.ok(effect(context.store).claim, 'Claim must be persisted before effects');

        entered();
        await held;

        return remote.provider.publish(input, signal);
      },
    };
    const first = publishGithubEffect(request(context.root), {
      store: context.store,
      provider,
      nextId: context.nextId,
    });
    await ready;
    const sibling = await context.openSibling();
    const competing = await publishGithubEffect(request(context.root), {
      store: sibling,
      provider,
      nextId: context.nextId,
    });
    sibling.close();
    release();
    const result = persisted(await first);

    assert.ok(
      competing.outcome === 'rejected' && competing.error.code === 'state_reconciliation_required',
    );
    assert.equal(sends, 1);
    assert.equal(remote.posts, 1);
    assert.equal(result.state, 'confirmed');
  });
});

await test('journal blocks a saved unattempted claim after controller loss without treating age as permission', async () => {
  const p = publication('comment');
  await fixture(p, async (context) => {
    persisted(
      context.store.claimEffect({
        schemaVersion: 1,
        effectId: 'publication-effect',
        owner: 'stopped-controller',
        token: 'original-token',
        leaseMs: 1,
      }),
    );
    context.advance();
    await context.reopen();
    const remote = remoteFixture(p, context.directory);
    const retry = await publishGithubEffect(request(context.root), {
      store: context.store,
      provider: remote.provider,
      nextId: context.nextId,
    });
    const reconciled = persisted(
      await publishGithubEffect(request(context.root, 'reconcile', true), {
        store: context.store,
        provider: remote.provider,
        nextId: context.nextId,
      }),
    );

    assert.ok(retry.outcome === 'rejected' && retry.error.code === 'state_reconciliation_required');
    assert.equal(reconciled.state, 'unknown');
    assert.equal(remote.posts, 0);
  });
});

await test('journal handles uncertain local commits before and after saving the remote receipt', async () => {
  for (const actuallyPersisted of [false, true]) {
    const p = publication('comment');
    await fixture(p, async (context) => {
      const remote = remoteFixture(p, context.directory);
      const store: StateStore = {
        ...context.store,
        resolveEffect(input) {
          if (actuallyPersisted) {
            persisted(context.store.resolveEffect(input));
          }

          return {
            schemaVersion: 1,
            outcome: 'uncertain',
            error: { code: 'state_write_uncertain', message: 'Injected local commit uncertainty' },
          };
        },
      };
      const first = await publishGithubEffect(request(context.root), {
        store,
        provider: remote.provider,
        nextId: context.nextId,
      });

      assert.equal(first.outcome, 'uncertain');
      assert.equal(remote.posts, 1);

      await context.reopen();
      const retry = await publishGithubEffect(request(context.root), {
        store: context.store,
        provider: remote.provider,
        nextId: context.nextId,
      });

      if (actuallyPersisted) {
        assert.equal(persisted(retry).state, 'confirmed');
      } else {
        assert.ok(
          retry.outcome === 'rejected' && retry.error.code === 'state_reconciliation_required',
        );
        assert.equal(
          persisted(
            await publishGithubEffect(request(context.root, 'reconcile', true), {
              store: context.store,
              provider: remote.provider,
              nextId: context.nextId,
            }),
          ).state,
          'confirmed',
        );
      }

      assert.equal(remote.posts, 1);
    });
  }
});

await test('journal does not invoke the provider after uncertain claim persistence', async () => {
  const p = publication('comment');
  await fixture(p, async (context) => {
    const remote = remoteFixture(p, context.directory);
    const store: StateStore = {
      ...context.store,
      claimEffect(input) {
        persisted(context.store.claimEffect(input));

        return {
          schemaVersion: 1,
          outcome: 'uncertain',
          error: { code: 'state_write_uncertain', message: 'Injected claim commit uncertainty' },
        };
      },
    };
    const first = await publishGithubEffect(request(context.root), {
      store,
      provider: remote.provider,
      nextId: context.nextId,
    });

    assert.equal(first.outcome, 'uncertain');
    assert.equal(remote.calls.length, 0);
    assert.ok(effect(context.store).claim);

    await context.reopen();
    const retry = await publishGithubEffect(request(context.root), {
      store: context.store,
      provider: remote.provider,
      nextId: context.nextId,
    });

    assert.ok(retry.outcome === 'rejected' && retry.error.code === 'state_reconciliation_required');
    assert.equal(remote.calls.length, 0);
  });
});

await test('journal retains provider exceptions and invalid receipts as unknown outcomes', async () => {
  for (const broken of ['throw', 'wrong-sha'] as const) {
    const p = publication('comment');
    await fixture(p, async (context) => {
      const remote = remoteFixture(p, context.directory);
      const provider: GithubProvider = {
        ...remote.provider,
        async publish(input) {
          if (broken === 'throw') {
            throw new Error('fixture-secret');
          }

          return {
            schemaVersion: 1,
            outcome: 'completed',
            value: {
              schemaVersion: 1,
              kind: 'comment',
              marker: input.marker,
              actor: p.actor,
              target: { ...target, sha: 'd'.repeat(40) },
              id: 99,
              observedAt: 1000,
            },
          };
        },
      };
      const result = persisted(
        await publishGithubEffect(request(context.root), {
          store: context.store,
          provider,
          nextId: context.nextId,
        }),
      );

      assert.equal(result.state, 'unknown');
      assert.equal(JSON.stringify(result.evidence).includes('fixture-secret'), false);
    });
  }
});

await test('journal rejects mismatched attempt commits and respects cancellation before claiming', async () => {
  const wrong = { ...publication('comment'), target: { ...target, sha: 'd'.repeat(40) } };
  await fixture(wrong, async (context) => {
    const remote = remoteFixture(wrong, context.directory);
    const result = await publishGithubEffect(request(context.root), {
      store: context.store,
      provider: remote.provider,
      nextId: context.nextId,
    });

    assert.ok(result.outcome === 'rejected' && result.error.code === 'github_conflict');
    assert.equal(effect(context.store).claim, null);
    assert.equal(remote.calls.length, 0);
  });

  const p = publication('comment');
  await fixture(p, async (context) => {
    const remote = remoteFixture(p, context.directory);
    const controller = new AbortController();
    controller.abort();
    const result = await publishGithubEffect(
      request(context.root),
      { store: context.store, provider: remote.provider, nextId: context.nextId },
      controller.signal,
    );

    assert.ok(result.outcome === 'rejected' && result.error.code === 'cancelled');
    assert.equal(effect(context.store).claim, null);
    assert.equal(remote.calls.length, 0);
  });
});

await test('journal closes known preflight rejection but preserves post-send rate-limit uncertainty and hints', async () => {
  for (const afterSend of [false, true]) {
    const p = publication('comment');
    await fixture(p, async (context) => {
      const remote = remoteFixture(p, context.directory);
      const provider: GithubProvider = afterSend
        ? remote.provider
        : {
            ...remote.provider,
            async publish() {
              return {
                schemaVersion: 1,
                outcome: 'rejected',
                error: { code: 'github_rate_limited', message: 'Fixture', retryAfterMs: 2000 },
              };
            },
          };
      remote.postResult = http({ message: 'fixture-secret' }, 429, { 'Retry-After': '2' });
      const result = persisted(
        await publishGithubEffect(request(context.root), {
          store: context.store,
          provider,
          nextId: context.nextId,
        }),
      );

      assert.equal(result.state, afterSend ? 'unknown' : 'cancelled');
      assert.equal(result.evidence?.retryAfterMs, 2000);
      assert.equal(result.evidence?.[afterSend ? 'cause' : 'code'], 'github_rate_limited');
      assert.equal(remote.posts, afterSend ? 1 : 0);

      const retry = await publishGithubEffect(request(context.root), {
        store: context.store,
        provider,
        nextId: context.nextId,
      });

      assert.equal(retry.outcome, 'rejected');
      assert.equal(remote.posts, afterSend ? 1 : 0);
    });
  }
});

await test('journal preserves accepted publication intent when a caller tries to replace its payload', async () => {
  const p = publication('comment');
  await fixture(p, async (context) => {
    const original = effect(context.store);
    const changed = prepareStateAttempt(
      {
        schemaVersion: 1,
        attempt: {
          id: 'publication-attempt',
          jobId: 'publication-job',
          number: 1,
          branch: 'refs/heads/feature',
          commit: target.sha,
          createdAt: 1000,
        },
        effects: [
          {
            ...original.intent,
            payload: { publication: { ...p, body: 'Changed business intent' } },
          },
        ],
      },
      context.store,
    );

    assert.ok(changed.outcome === 'rejected' && changed.error.code === 'state_conflict');
    assert.deepEqual(effect(context.store), original);
  });
});

await test('journal returns a stable error if controller identifier allocation fails before claiming', async () => {
  const p = publication('comment');

  for (const failureAt of [1, 2]) {
    await fixture(p, async (context) => {
      const remote = remoteFixture(p, context.directory);
      let calls = 0;
      const result = await publishGithubEffect(request(context.root), {
        store: context.store,
        provider: remote.provider,
        nextId() {
          calls++;

          if (calls === failureAt) {
            throw new Error('fixture-secret');
          }

          return 'fixture-controller';
        },
      });

      assert.ok(result.outcome === 'rejected' && result.error.code === 'state_unavailable');
      assert.equal(effect(context.store).claim, null);
      assert.equal(remote.calls.length, 0);
      assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    });
  }
});
