import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { completed, rejected } from '../../contracts/operation-result.js';
import { portEndpointSchema } from '../../contracts/resources.js';
import type { PortProbe } from '../../ports/resources.js';

export const nodePortProbe: PortProbe = {
  async inspect(input, signal) {
    const parsed = portEndpointSchema.safeParse(input);

    if (!parsed.success) {
      return rejected(
        'invalid_request',
        'Select a numeric supported bind address, protocol and unprivileged port.',
      );
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Port inspection was cancelled.');
    }

    const endpoint = parsed.data;

    return new Promise((resolve) => {
      let observation: 'free' | 'busy' | 'unknown' = 'unknown';
      let finishing = false;
      const socket =
        endpoint.protocol === 'tcp'
          ? createServer()
          : createSocket({
              type: endpoint.host.includes(':') ? 'udp6' : 'udp4',
              reuseAddr: false,
              ...(endpoint.host.includes(':') ? { ipv6Only: true } : {}),
            });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(completed(observation));
      };

      const finish = () => {
        if (finishing) {
          return;
        }

        finishing = true;

        try {
          if (endpoint.protocol === 'tcp') {
            (socket as ReturnType<typeof createServer>).close(() => done());
          } else {
            (socket as ReturnType<typeof createSocket>).close(() => done());
          }
        } catch {
          done();
        }
      };

      const abort = () => {
        observation = 'unknown';
        finish();
      };

      const timer = setTimeout(abort, 1000);
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        observation = error.code === 'EADDRINUSE' ? 'busy' : 'unknown';
        finish();
      });
      socket.once('listening', () => {
        if (finishing) {
          // A delayed bind must still close, even after cancellation/timeout.
          try {
            socket.close();
          } catch {}

          return;
        }

        observation = signal?.aborted ? 'unknown' : 'free';
        finish();
      });

      try {
        if (endpoint.protocol === 'tcp') {
          (socket as ReturnType<typeof createServer>).listen({
            host: endpoint.host,
            port: endpoint.port,
            exclusive: true,
            ipv6Only: true,
          });
        } else {
          (socket as ReturnType<typeof createSocket>).bind({
            address: endpoint.host,
            port: endpoint.port,
            exclusive: true,
          });
        }
      } catch {
        finish();
      }
    });
  },
};
