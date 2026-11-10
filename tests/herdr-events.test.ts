import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { watchHerdrPane } from '../src/adapters/herdr/event-stream.js';
import { nodeHerdrEndpointReader } from '../src/adapters/filesystem/herdr-endpoint.js';

await test(
  'Herdr event stream handles fragments, filters panes and reconnects after a dropped socket',
  { timeout: 20000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'as-events-')));
    const path = join(directory, 'h.sock');
    const connections: Socket[] = [];
    const server = createServer((connection) => {
      connections.push(connection);
      let request = '';
      connection.on('data', (data) => {
        request += data.toString();

        if (request.includes('\n')) {
          const parsed = JSON.parse(request) as {
            id: string;
            method: string;
            params: { subscriptions: unknown[] };
          };

          assert.equal(parsed.method, 'events.subscribe');
          assert.equal(parsed.params.subscriptions.length, 2);

          connection.write(
            `${JSON.stringify({ id: parsed.id, result: { type: 'subscription_started' } })}\n`,
          );
        }
      });
    });
    let stop = () => {};

    try {
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(path, resolve),
      );
      await chmod(path, 0o600);
      const target = { session: 'test', socketPath: path };
      const identity = await nodeHerdrEndpointReader.read(target);
      let changes = 0;
      stop = watchHerdrPane({
        server: { ...identity, protocol: 22 },
        paneId: 'w1:p1',
        endpoint: nodeHerdrEndpointReader,
        reconnectMs: 20,
        acknowledgementTimeoutMs: 30,
        changed: () => changes++,
      });
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;

        while (!predicate() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        assert.ok(predicate(), 'Timed out waiting for Herdr socket event');
      };

      await until(() => changes === 1);
      await new Promise((resolve) => setTimeout(resolve, 75));

      assert.equal(connections.length, 1);

      const connection = connections[0]!;
      connection.write('{"event":"pane_closed","data":{"pane_id":"other"}}\n');
      connection.write('{"event":"pane.agent_status_');
      connection.write('changed","data":{"pane_id":"w1:p1","agent_status":"idle"}}\n');
      await until(() => changes === 2);
      connection.destroy();
      await until(() => connections.length === 2 && changes >= 4);
    } finally {
      stop();

      for (const connection of connections) {
        connection.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

await test(
  'a changed Herdr endpoint never receives a subscription',
  { timeout: 10000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'as-events-')));
    const path = join(directory, 'h.sock');
    let received = false;
    const connections: Socket[] = [];
    const server = createServer((connection) => {
      connections.push(connection);
      connection.on('data', () => {
        received = true;
      });
    });
    let stop = () => {};

    try {
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(path, resolve),
      );
      await chmod(path, 0o600);
      const target = { session: 'test', socketPath: path };
      const identity = await nodeHerdrEndpointReader.read(target);
      let calls = 0;
      let changes = 0;
      stop = watchHerdrPane({
        server: { ...identity, protocol: 22 },
        paneId: 'w1:p1',
        endpoint: {
          async read() {
            calls++;

            return calls === 1 ? identity : { ...identity, inode: '999999' };
          },
        },
        reconnectMs: 10000,
        changed: () => changes++,
      });

      for (let i = 0; i < 500 && changes === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.ok(changes > 0);
      assert.equal(received, false);
    } finally {
      stop();

      for (const connection of connections) {
        connection.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

await test(
  'a stalled subscription reconnects instead of silently missing events',
  { timeout: 10000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'as-events-')));
    const path = join(directory, 'h.sock');
    const connections: Socket[] = [];
    const server = createServer((connection) => {
      connections.push(connection);
    });
    let stop = () => {};

    try {
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(path, resolve),
      );
      await chmod(path, 0o600);
      const target = { session: 'test', socketPath: path };
      const identity = await nodeHerdrEndpointReader.read(target);
      let changes = 0;
      stop = watchHerdrPane({
        server: { ...identity, protocol: 22 },
        paneId: 'w1:p1',
        endpoint: nodeHerdrEndpointReader,
        reconnectMs: 10,
        acknowledgementTimeoutMs: 30,
        changed: () => changes++,
      });

      for (let i = 0; i < 500 && connections.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.ok(connections.length >= 2);
      assert.ok(changes >= 1);
    } finally {
      stop();

      for (const connection of connections) {
        connection.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
