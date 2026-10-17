import { createConnection } from 'node:net';
import { join } from 'node:path';
import { serviceRpcResponseSchema, type ServiceRpcResponse } from '../../contracts/service.js';
import { rejected } from '../../contracts/operation-result.js';
import { endpointEvidence, serviceRoot, serviceSocketName } from '../../core/service-endpoint.js';

export async function requestLocalService(
  stateDirectory: string,
  request: unknown,
): Promise<ServiceRpcResponse> {
  let path: string;

  try {
    const root = await serviceRoot(stateDirectory);
    const evidence = await endpointEvidence(root);

    if (!evidence.info || !evidence.record) {
      return rejected(
        'service_unavailable',
        'No service endpoint is available for this state directory.',
      );
    }

    path = join(root.path, serviceSocketName);
  } catch {
    return rejected(
      'service_endpoint_unsafe',
      'Service endpoint ownership could not be verified; preserve its files and inspect host state.',
    );
  }

  return new Promise((resolve) => {
    const socket = createConnection(path);
    let buffer = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(
      () =>
        finish(
          rejected(
            'service_unavailable',
            'Service did not acknowledge the request; inspect or retry using the same idempotency key.',
          ),
        ),
      30_000,
    );

    function finish(result: ServiceRpcResponse): void {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      }
    }

    socket.once('connect', () => {
      try {
        const bytes = JSON.stringify(request);

        if (Buffer.byteLength(bytes) > 65_534) {
          throw new Error('Request too large');
        }

        socket.write(`${bytes}\n`);
      } catch {
        finish(rejected('invalid_request', 'Request exceeds the local protocol contract.'));
      }
    });
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > 262_144) {
        finish(
          rejected('service_protocol_error', 'Service response exceeds the local protocol limit.'),
        );

        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.includes(10)) {
        try {
          const result = serviceRpcResponseSchema.parse(
            JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(buffer)) as unknown,
          );
          finish(result);
        } catch {
          finish(rejected('service_protocol_error', 'Service returned an invalid response.'));
        }
      }
    });
    socket.once('error', () =>
      finish(
        rejected(
          'service_unavailable',
          'Service connection failed; inspect or retry using the same idempotency key.',
        ),
      ),
    );
    socket.once('close', () =>
      finish(
        rejected(
          'service_unavailable',
          'Service disconnected before acknowledgment; inspect or retry using the same idempotency key.',
        ),
      ),
    );
  });
}
