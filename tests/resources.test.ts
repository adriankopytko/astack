import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './support/service.js';
import {
  reserveAllocation,
  startAllocation,
  confirmAllocationRunning,
  retainAllocation,
  releaseAllocation,
  listAllocations,
  allocationRecordSchema,
  allocationWriteResultSchema,
  nodePortProbe,
  openSqliteState,
  acquireCoordinatorOwnership,
  type AllocationDependencies,
  type AllocationRecord,
  type AllocationRequest,
} from '../src/index.js';
import { completed } from '../src/contracts/operation-result.js';
const options = { timeout: 120000 };
function saved(result: Awaited<ReturnType<typeof reserveAllocation>>) {
  allocationWriteResultSchema.parse(result);

  assert.equal(result.outcome, 'persisted', JSON.stringify(result));

  if (result.outcome !== 'persisted') {
    assert.fail(JSON.stringify(result));
  }

  return result.value;
}

function port(
  jobId: string,
  attemptId: string,
  key = 'api',
  candidates = [32101, 32102, 32103],
): AllocationRequest {
  return {
    schemaVersion: 1,
    jobId,
    attemptId,
    key,
    spec: { kind: 'port', protocol: 'tcp', host: '127.0.0.1', candidates },
  };
}

function release(record: AllocationRecord) {
  return {
    schemaVersion: 1,
    id: record.id,
    expectedRevision: record.revision,
    key: 'release',
    startupKey: record.startup?.key ?? null,
    writersStopped: true as const,
    servicesStopped: true as const,
  };
}

const endpointPort = (record: AllocationRecord) => {
  assert.equal(record.value.kind, 'port');

  if (record.value.kind !== 'port') {
    assert.fail('expected port');
  }

  return record.value.port;
};

await test(
  'shared claims isolate projects, serialize fixed endpoints, and produce scoped names without ambient targets',
  options,
  async () => {
    await fixture(async (f) => {
      const first = await f.submit(0, 'first');
      const second = await f.submit(1, 'second');
      const reopened = await openSqliteState({ schemaVersion: 1, stateDirectory: f.state });

      assert.ok(reopened.outcome === 'opened');

      try {
        const deps: AllocationDependencies = {
          allocations: f.opened.allocations,
          ports: { inspect: async () => completed('free') },
        };
        const other = { ...deps, allocations: reopened.allocations };
        const request = port(first.job.id, first.attempt.id);
        const [a, b] = await Promise.all([
          reserveAllocation(request, deps),
          reserveAllocation(port(second.job.id, second.attempt.id), other),
        ]);
        const one = saved(a);
        const two = saved(b);

        assert.equal(one.binding.projectId, 'project-0');
        assert.equal(two.binding.projectId, 'project-1');
        assert.notEqual(endpointPort(one), endpointPort(two));
        assert.equal(saved(await reserveAllocation(request, other)).id, one.id);

        const fixed = await reserveAllocation(
          port(second.job.id, second.attempt.id, 'fixed', [32101]),
          deps,
        );

        assert.ok(fixed.outcome === 'rejected' && fixed.error.code === 'resource_conflict');

        const wildcard = await reserveAllocation(
          {
            ...port(second.job.id, second.attempt.id, 'wildcard', [32101]),
            spec: { kind: 'port', protocol: 'tcp', host: '::', candidates: [32101] },
          },
          deps,
        );

        assert.ok(wildcard.outcome === 'rejected' && wildcard.error.code === 'resource_conflict');

        const udp = saved(
          await reserveAllocation(
            {
              ...port(second.job.id, second.attempt.id, 'udp', [32101]),
              spec: { kind: 'port', protocol: 'udp', host: '127.0.0.1', candidates: [32101] },
            },
            deps,
          ),
        );

        assert.equal(endpointPort(udp), 32101);

        const named = (
          jobId: string,
          attemptId: string,
          key: string,
          fixed = false,
        ): AllocationRequest => ({
          schemaVersion: 1,
          jobId,
          attemptId,
          key,
          spec: { kind: 'name', namespace: 'cache', prefix: 'cache', fixed },
        });
        const n1 = saved(
          await reserveAllocation(named(first.job.id, first.attempt.id, 'cache'), deps),
        );
        const n2 = saved(
          await reserveAllocation(named(second.job.id, second.attempt.id, 'cache'), other),
        );

        assert.notDeepEqual(n1.value, n2.value);

        saved(
          await reserveAllocation(named(first.job.id, first.attempt.id, 'fixed-cache', true), deps),
        );
        const clash = await reserveAllocation(
          named(second.job.id, second.attempt.id, 'fixed-cache', true),
          other,
        );

        assert.ok(clash.outcome === 'rejected' && clash.error.code === 'resource_conflict');

        const page = listAllocations({ schemaVersion: 1, projectId: 'project-0', limit: 1 }, deps);

        assert.ok(
          page.outcome === 'completed' && page.value.items.length === 1 && page.value.nextCursor,
        );

        const mismatch = await reserveAllocation({ ...request, jobId: second.job.id }, deps);

        assert.ok(mismatch.outcome === 'rejected');

        const changed = await reserveAllocation(
          {
            ...request,
            spec: {
              ...request.spec,
              kind: 'port',
              protocol: 'udp',
              host: '127.0.0.1',
              candidates: [32101],
            },
          },
          deps,
        );

        assert.ok(changed.outcome === 'rejected' && changed.error.code === 'state_conflict');
      } finally {
        reopened.store.close();
      }
    });
  },
);
await test(
  'unmanaged listeners trigger bounded fallback only before startup; unknown probes retain their claims',
  options,
  async () => {
    await fixture(async (f) => {
      const job = await f.submit(0, 'fallback');
      let observation: 'free' | 'busy' | 'unknown' = 'busy';
      let probes = 0;
      const deps: AllocationDependencies = {
        allocations: f.opened.allocations,
        ports: {
          inspect: async (endpoint) => {
            probes++;

            return completed(endpoint.port === 32101 ? 'busy' : observation);
          },
        },
      };
      observation = 'free';
      const request = port(job.job.id, job.attempt.id);
      const record = saved(await reserveAllocation(request, deps));

      assert.equal(endpointPort(record), 32102);
      assert.equal(probes, 2);

      observation = 'busy';
      const blocked = saved(
        await startAllocation(
          {
            schemaVersion: 1,
            id: record.id,
            expectedRevision: record.revision,
            key: 'start',
            controller: 'fixture',
          },
          deps,
        ),
      );

      assert.equal(blocked.phase, 'blocked');
      assert.equal(blocked.startup, null);

      observation = 'free';
      const moved = saved(await reserveAllocation(request, deps));

      assert.equal(endpointPort(moved), 32103);

      const started = saved(
        await startAllocation(
          {
            schemaVersion: 1,
            id: moved.id,
            expectedRevision: moved.revision,
            key: 'start',
            controller: 'fixture',
          },
          deps,
        ),
      );

      assert.equal(started.phase, 'starting');

      const before = probes;
      const retry = await startAllocation(
        {
          schemaVersion: 1,
          id: moved.id,
          expectedRevision: moved.revision,
          key: 'start',
          controller: 'fixture',
        },
        deps,
      );

      assert.equal(retry.outcome, 'persisted');

      if (retry.outcome === 'persisted') {
        assert.equal(retry.disposition, 'existing');
      }

      assert.equal(probes, before);

      const repeated = saved(await reserveAllocation(request, deps));

      assert.equal(repeated.phase, 'starting');
      assert.equal(endpointPort(repeated), 32103);

      observation = 'unknown';
      const unknownRequest = port(job.job.id, job.attempt.id, 'unknown', [32104, 32105]);
      const unknown = saved(await reserveAllocation(unknownRequest, deps));

      assert.equal(unknown.phase, 'blocked');
      assert.equal(unknown.probe, 'unknown');
      assert.equal(endpointPort(unknown), 32104);

      observation = 'free';

      assert.equal(endpointPort(saved(await reserveAllocation(unknownRequest, deps))), 32104);

      const fixedRequest = port(job.job.id, job.attempt.id, 'fixed-later', [32106]);
      observation = 'busy';
      const busyFixed = saved(await reserveAllocation(fixedRequest, deps));

      assert.equal(busyFixed.phase, 'blocked');

      observation = 'free';
      const freeFixed = saved(await reserveAllocation(fixedRequest, deps));

      assert.equal(freeFixed.id, busyFixed.id);
      assert.equal(freeFixed.phase, 'reserved');
      assert.equal(endpointPort(freeFixed), 32106);
    });
  },
);
await test(
  'verified running/retained environments hold allocations until exact host shutdown and fresh absence evidence',
  options,
  async () => {
    await fixture(async (f) => {
      const job = await f.submit(0, 'retained');
      const competitor = await f.submit(1, 'competitor');
      let evidence: 'free' | 'busy' | 'unknown' = 'free';
      const deps: AllocationDependencies = {
        allocations: f.opened.allocations,
        ports: { inspect: async () => completed(evidence) },
      };
      const allocated = saved(
        await reserveAllocation(port(job.job.id, job.attempt.id, 'api', [32101]), deps),
      );
      const start = {
        schemaVersion: 1 as const,
        id: allocated.id,
        expectedRevision: allocated.revision,
        key: 'start',
        controller: 'fixture',
      };
      const starting = saved(await startAllocation(start, deps));
      const noListener = await confirmAllocationRunning(
        { ...start, expectedRevision: starting.revision, ownedEndpointVerified: true },
        deps,
      );

      assert.ok(noListener.outcome === 'rejected');

      evidence = 'busy';
      const noOwnership = await confirmAllocationRunning(
        { ...start, expectedRevision: starting.revision },
        deps,
      );

      assert.ok(noOwnership.outcome === 'rejected' && noOwnership.error.code === 'invalid_request');

      const running = saved(
        await confirmAllocationRunning(
          { ...start, expectedRevision: starting.revision, ownedEndpointVerified: true },
          deps,
        ),
      );
      const retained = saved(
        retainAllocation(
          { schemaVersion: 1, id: running.id, expectedRevision: running.revision },
          deps,
        ),
      );
      f.advance();
      const other = await reserveAllocation(
        port(competitor.job.id, competitor.attempt.id, 'api', [32101]),
        deps,
      );

      assert.ok(other.outcome === 'rejected' && other.error.code === 'resource_conflict');

      const rawRelease = f.opened.store.releaseResource({
        schemaVersion: 1,
        resourceId: retained.id,
        attemptId: job.attempt.id,
        evidence: { stopped: true },
      });

      assert.ok(rawRelease.outcome === 'rejected');

      const busyRelease = await releaseAllocation(release(retained), deps);

      assert.ok(
        busyRelease.outcome === 'rejected' && busyRelease.error.code === 'resource_blocked',
      );

      evidence = 'unknown';

      assert.equal((await releaseAllocation(release(retained), deps)).outcome, 'rejected');

      evidence = 'free';
      const wrong = await releaseAllocation({ ...release(retained), startupKey: 'another' }, deps);

      assert.ok(wrong.outcome === 'rejected');

      const released = saved(await releaseAllocation(release(retained), deps));

      assert.equal(released.phase, 'released');
      assert.equal(
        saved(await releaseAllocation(release(retained), deps)).revision,
        released.revision,
      );
      assert.equal(
        saved(
          await reserveAllocation(
            port(competitor.job.id, competitor.attempt.id, 'api', [32101]),
            deps,
          ),
        ).phase,
        'reserved',
      );
      assert.equal(
        saved(await reserveAllocation(port(job.job.id, job.attempt.id, 'api', [32101]), deps))
          .phase,
        'released',
      );

      const hold = f.opened.store.inspectRecord({
        schemaVersion: 1,
        entity: 'resource',
        id: retained.id,
      });

      assert.ok(
        hold.outcome === 'completed' &&
          hold.value?.entity === 'resource' &&
          hold.value.record.releasedAt !== null,
      );
    });
  },
);
await test(
  'stale probe races, cancellation and invalid input never authorize startup or release a retained claim',
  options,
  async () => {
    await fixture(async (f) => {
      const job = await f.submit(0, 'race');
      const request = port(job.job.id, job.attempt.id);
      let calls = 0;
      const deps: AllocationDependencies = {
        allocations: f.opened.allocations,
        ports: {
          inspect: async () => {
            calls++;

            return completed('free');
          },
        },
      };

      assert.equal(
        (
          await reserveAllocation(
            {
              ...request,
              spec: { kind: 'port', protocol: 'tcp', host: 'localhost', candidates: [80] },
            },
            deps,
          )
        ).outcome,
        'rejected',
      );
      assert.equal(
        (await reserveAllocation(request, deps, AbortSignal.abort())).outcome,
        'rejected',
      );
      assert.equal(calls, 0);

      const initial = saved(await reserveAllocation(request, deps));
      let concurrent: AllocationRecord | null = null;
      const stale: AllocationDependencies = {
        ...deps,
        ports: {
          inspect: async () => {
            concurrent = saved(
              f.opened.allocations.start({
                schemaVersion: 1,
                id: initial.id,
                expectedRevision: initial.revision,
                key: 'concurrent',
                controller: 'other',
              }),
            );

            return completed('free');
          },
        },
      };
      const rejected = await startAllocation(
        {
          schemaVersion: 1,
          id: initial.id,
          expectedRevision: initial.revision,
          key: 'loser',
          controller: 'fixture',
        },
        stale,
      );

      assert.ok(rejected.outcome === 'rejected' && rejected.error.code === 'state_conflict');
      assert.ok(concurrent);

      const current = f.opened.allocations.inspect(initial.id);

      assert.ok(current.outcome === 'completed' && current.value?.startup?.key === 'concurrent');

      const releaseRace = await releaseAllocation({ ...release(initial), startupKey: null }, deps);

      assert.ok(releaseRace.outcome === 'rejected');
    });
  },
);
await test(
  'native TCP and UDP probes close their own sockets and preserve unrelated listeners',
  options,
  async () => {
    const tcp = createServer();
    await new Promise<void>((resolve) => tcp.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const address = tcp.address();

    assert.ok(address && typeof address === 'object');

    const endpoint = { host: '127.0.0.1' as const, protocol: 'tcp' as const, port: address.port };

    try {
      assert.deepEqual(await nodePortProbe.inspect(endpoint), completed('busy'));
      assert.ok(tcp.listening);
    } finally {
      await new Promise<void>((resolve, reject) =>
        tcp.close((error) => (error ? reject(error) : resolve())),
      );
    }

    assert.deepEqual(await nodePortProbe.inspect(endpoint), completed('free'));
    assert.deepEqual(await nodePortProbe.inspect(endpoint), completed('free'));

    const udp = createSocket('udp4');
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    const datagram = { ...endpoint, protocol: 'udp' as const, port: udp.address().port };

    try {
      assert.deepEqual(await nodePortProbe.inspect(datagram), completed('busy'));
      assert.ok(udp.address().port > 0);
    } finally {
      await new Promise<void>((resolve) => udp.close(resolve));
    }

    assert.deepEqual(await nodePortProbe.inspect(datagram), completed('free'));
    assert.equal((await nodePortProbe.inspect(endpoint, AbortSignal.abort())).outcome, 'rejected');
  },
);
await test(
  'offline CLI validates requests before IO and refuses coordinator ownership conflicts; read commands do no setup',
  options,
  async () => {
    await fixture(async (f) => {
      const job = await f.submit(0, 'cli');
      const path = join(f.root, 'request.json');
      await writeFile(
        path,
        JSON.stringify({
          ...port(job.job.id, job.attempt.id),
          spec: { kind: 'name', namespace: 'service', prefix: 'api', fixed: false },
        }),
      );
      const entry = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
      const call = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [entry, '--state-directory', f.state, 'resources', ...args, '--json'],
          { cwd: f.root, encoding: 'utf8', timeout: 15000 },
        );
      const lock = await acquireCoordinatorOwnership(f.state);

      try {
        const blocked = call('reserve', '--file', path);

        assert.equal(blocked.status, 1, blocked.stdout || blocked.stderr);
        assert.equal(JSON.parse(blocked.stdout).error.code, 'service_already_running');
      } finally {
        lock.release();
      }

      const applied = call('reserve', '--file', path);

      assert.equal(applied.status, 0, applied.stdout || applied.stderr);

      const record = saved(allocationWriteResultSchema.parse(JSON.parse(applied.stdout)));
      const inspected = call('inspect', record.id);

      assert.equal(inspected.status, 0, inspected.stderr);

      allocationRecordSchema.parse(JSON.parse(inspected.stdout).value);
      const list = call('list', '--project', record.binding.projectId, '--limit', '1');

      assert.equal(list.status, 0, list.stderr);
      assert.equal(JSON.parse(list.stdout).value.items.length, 1);

      await assert.rejects(access(join(f.sources[0]!, '.astack')), { code: 'ENOENT' });
    });
  },
);

await test(
  'cancellation blocks new startup without releasing existing resources; release races preserve the winning claim',
  options,
  async () => {
    await fixture(async (f) => {
      const job = await f.submit(0, 'cancel');
      const deps: AllocationDependencies = {
        allocations: f.opened.allocations,
        ports: { inspect: async () => completed('free') },
      };
      const record = saved(await reserveAllocation(port(job.job.id, job.attempt.id), deps));
      const racing = {
        ...deps,
        ports: {
          inspect: async () => {
            saved(
              f.opened.allocations.start({
                schemaVersion: 1,
                id: record.id,
                expectedRevision: record.revision,
                key: 'won-startup',
                controller: 'fixture',
              }),
            );

            return completed('free' as const);
          },
        },
      };
      const lost = await releaseAllocation(release(record), racing);

      assert.ok(lost.outcome === 'rejected' && lost.error.code === 'state_conflict');

      const pending = f.opened.allocations.inspect(record.id);

      assert.ok(pending.outcome === 'completed' && pending.value?.phase === 'starting');

      const cancelled = f.opened.runs.cancel({
        schemaVersion: 1,
        jobId: job.job.id,
        key: 'cancel',
        interrupt: false,
      });

      assert.equal(cancelled.outcome, 'persisted', JSON.stringify(cancelled));

      const newAllocation = await reserveAllocation(port(job.job.id, job.attempt.id, 'new'), deps);

      assert.ok(
        newAllocation.outcome === 'rejected' && newAllocation.error.code === 'resource_blocked',
      );
      assert.ok(pending.outcome === 'completed' && pending.value);

      const current = pending.value;
      const after = await confirmAllocationRunning(
        {
          schemaVersion: 1,
          id: current.id,
          expectedRevision: current.revision,
          key: 'won-startup',
          controller: 'fixture',
          ownedEndpointVerified: true,
        },
        { ...deps, ports: { inspect: async () => completed('busy') } },
      );

      assert.equal(after.outcome, 'rejected');
      assert.equal(saved(await releaseAllocation(release(current), deps)).phase, 'released');
    });
  },
);
await test(
  'allocation and cleanup hold roll back together if their event cannot commit',
  options,
  async () => {
    await fixture(async (f) => {
      const job = await f.submit(0, 'rollback');
      const raw = new DatabaseSync(join(f.state, 'state.sqlite'));
      let probes = 0;
      const deps: AllocationDependencies = {
        allocations: f.opened.allocations,
        ports: {
          inspect: async () => {
            probes++;

            return completed('free');
          },
        },
      };

      try {
        raw.exec(
          "CREATE TRIGGER fail_allocation_event BEFORE INSERT ON run_events WHEN json_extract(NEW.data,'$.kind')='allocation_changed' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;",
        );
        const result = await reserveAllocation(port(job.job.id, job.attempt.id), deps);

        assert.equal(result.outcome, 'rejected');
        assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM resource_allocations').get()?.n, 0);
        assert.equal(
          raw.prepare("SELECT COUNT(*) AS n FROM resources WHERE kind='allocation'").get()?.n,
          0,
        );
        assert.equal(probes, 0);

        raw.exec('DROP TRIGGER fail_allocation_event');
        const record = saved(await reserveAllocation(port(job.job.id, job.attempt.id), deps));

        assert.equal(record.phase, 'reserved');
        assert.equal(
          raw
            .prepare(
              "SELECT COUNT(*) AS n FROM run_events WHERE json_extract(data,'$.kind')='allocation_changed'",
            )
            .get()?.n,
          2,
        );
      } finally {
        raw.close();
      }
    });
  },
);
