import { connect, type Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { HerdrServer } from '../../contracts/herdr.js';
import type { HerdrEndpointReader } from '../../ports/herdr.js';

/** Events are hints only: callers must inspect fresh provider state before acting. */
export function watchHerdrPane(input: {
  server: HerdrServer;
  paneId: string;
  endpoint: HerdrEndpointReader;
  changed: () => void;
  reconnectMs?: number;
  acknowledgementTimeoutMs?: number;
}) {
  let stopped = false;
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function start() {
    try {
      const expected = { ...input.server };
      const actual = { ...(await input.endpoint.read(input.server)), protocol: 22 as const };

      if (!isDeepStrictEqual(expected, actual) || stopped) {
        throw new Error('Herdr endpoint changed');
      }

      const connection = connect(input.server.socketPath);
      socket = connection;
      let pending = Buffer.alloc(0);
      let acknowledged = false;
      let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
      connection.on('error', () => connection.destroy());
      connection.once('connect', () => {
        void (async () => {
          const after = { ...(await input.endpoint.read(input.server)), protocol: 22 as const };

          if (stopped || socket !== connection || !isDeepStrictEqual(expected, after)) {
            connection.destroy();

            return;
          }

          connection.write(
            `${JSON.stringify({ id: 'astack-events', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.closed' }, { type: 'pane.agent_status_changed', pane_id: input.paneId }] } })}\n`,
          );
          acknowledgementTimer = setTimeout(
            () => connection.destroy(),
            input.acknowledgementTimeoutMs ?? 10000,
          );
          acknowledgementTimer.unref();
        })().catch(() => connection.destroy());
      });
      connection.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);

        if (pending.length > 65536) {
          connection.destroy();

          return;
        }

        while (pending.includes(10)) {
          const offset = pending.indexOf(10);
          const line = pending.subarray(0, offset);
          pending = pending.subarray(offset + 1);
          let value: unknown;

          try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
          } catch {
            connection.destroy();

            return;
          }

          if (!value || typeof value !== 'object') {
            connection.destroy();

            return;
          }

          const message = value as Record<string, unknown>;

          if (!acknowledged) {
            const result = message.result as { type?: unknown } | undefined;

            if (message.id !== 'astack-events' || result?.type !== 'subscription_started') {
              connection.destroy();

              return;
            }

            acknowledged = true;

            if (acknowledgementTimer) {
              clearTimeout(acknowledgementTimer);
              acknowledgementTimer = undefined;
            }

            input.changed();
            continue;
          }

          const data = message.data as { pane_id?: unknown } | undefined;

          if (
            data?.pane_id === input.paneId &&
            (message.event === 'pane_closed' ||
              message.event === 'pane_agent_status_changed' ||
              message.event === 'pane.agent_status_changed')
          ) {
            input.changed();
          }
        }
      });
      connection.once('close', () => {
        if (acknowledgementTimer) {
          clearTimeout(acknowledgementTimer);
        }

        if (socket === connection) {
          socket = undefined;
        }

        if (!stopped) {
          input.changed();
          timer = setTimeout(() => void start(), input.reconnectMs ?? 1000);
          timer.unref();
        }
      });
    } catch {
      if (!stopped) {
        input.changed();
        timer = setTimeout(() => void start(), input.reconnectMs ?? 1000);
        timer.unref();
      }
    }
  }

  void start();

  return () => {
    stopped = true;

    if (timer) {
      clearTimeout(timer);
    }

    socket?.destroy();
  };
}
