import { createServer, type Socket } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';
import { rejected } from '../contracts/operation-result.js';
import {
  serviceRoot,
  endpointEvidence,
  serviceSocketName,
  serviceEndpointName,
  endpointSchema,
} from '../core/service-endpoint.js';
import { exclusiveFile, readRegularFile } from '../core/file-paths.js';

/** Caller holds coordinator ownership before binding/reconciling this endpoint. */
export async function listenLocalService(input: {
  stateDirectory: string;
  sessionId: string;
  handle: (request: unknown, signal: AbortSignal) => Promise<ServiceRpcResponse>;
}) {
  const root = await serviceRoot(input.stateDirectory);
  const path = join(root.path, serviceSocketName);

  if (Buffer.byteLength(path) > 100) {
    throw new Error('Select a shorter local state directory for Unix sockets');
  }

  const existing = await endpointEvidence(root);

  if (existing.info) {
    await unlink(path);
  }

  if (existing.file) {
    await unlink(join(root.path, serviceEndpointName));
  }

  let ready = false;
  let closing = false;
  const connections = new Set<Socket>();
  const requests = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const controller = new AbortController();
    controllers.add(controller);
    socket.once('close', () => {
      controller.abort();
      controllers.delete(controller);
    });
    connections.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => connections.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());

    if (!ready || closing) {
      socket.destroy();

      return;
    }

    let buffer = Buffer.alloc(0);
    let received = false;
    socket.on('data', (chunk: Buffer) => {
      if (received) {
        return;
      }

      if (buffer.length + chunk.length > 65_536) {
        received = true;
        socket.end(
          `${JSON.stringify(rejected('service_protocol_error', 'Request exceeds the local protocol limit.'))}\n`,
        );

        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);

      if (newline < 0) {
        return;
      }

      received = true;
      const pending = (async () => {
        let result: ServiceRpcResponse;

        try {
          const text = new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, newline));
          const trailing = new TextDecoder('utf8', { fatal: true }).decode(
            buffer.subarray(newline + 1),
          );

          if (trailing.trim() !== '') {
            throw new Error('One request per connection');
          }

          result = await input.handle(JSON.parse(text) as unknown, controller.signal);
        } catch {
          result = rejected(
            'service_protocol_error',
            'Request could not be processed; inspect saved intent before retrying.',
          );
        }

        if (!socket.destroyed) {
          socket.end(`${JSON.stringify(result)}\n`);
        }
      })();
      requests.add(pending);
      void pending.then(
        () => requests.delete(pending),
        () => requests.delete(pending),
      );
    });
    socket.once('end', () => {
      if (!received) {
        socket.end();
      }
    });
  });
  server.maxConnections = 32;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
    const info = await lstat(path, { bigint: true });
    const record = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      device: String(info.dev),
      inode: String(info.ino),
    };
    const file = await exclusiveFile(root, serviceEndpointName);

    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }

    ready = true;
  } catch (error) {
    server.close();

    throw error;
  }

  return {
    path,
    async close(): Promise<void> {
      closing = true;

      for (const controller of controllers) {
        controller.abort();
      }

      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(requests);

      for (const socket of connections) {
        socket.destroy();
      }

      await closed;
      const file = await readRegularFile(root, serviceEndpointName, 4096);

      if (
        file &&
        endpointSchema.parse(JSON.parse(file.bytes.toString('utf8')) as unknown).sessionId ===
          input.sessionId
      ) {
        await unlink(join(root.path, serviceEndpointName));
      }
    },
  };
}
