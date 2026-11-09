import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { requestLocalService } from '../adapters/local/service-client.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { ServiceRpcResponse } from '../contracts/service-rpc.js';
import { serviceStatusSchema } from '../contracts/service.js';

/** Check service availability before submission; never resend a submitted request. */
export async function ensureLocalService(
  stateDirectory: string,
  options: { gitExecutable?: string; herdrExecutable?: string } = {},
): Promise<OperationResult<{ ready: true }>> {
  const status = () =>
    requestLocalService(stateDirectory, { schemaVersion: 1, operation: 'status' });
  let existing = await status();

  // A concurrent coordinator may be publishing its socket and ownership record.
  for (
    let attempt = 0;
    existing.outcome === 'rejected' &&
    existing.error.code === 'service_endpoint_unsafe' &&
    attempt < 10;
    attempt++
  ) {
    await delay(150);
    existing = await status();
  }

  if (existing.outcome === 'completed') {
    return serviceStatusSchema.safeParse(existing.value).success
      ? { schemaVersion: 1, outcome: 'completed', value: { ready: true } }
      : rejected('service_protocol_error', 'Service returned an invalid status response.');
  }

  if (existing.outcome !== 'rejected') {
    return rejected('service_protocol_error', 'Service returned an invalid status response.');
  }

  if (existing.error.code !== 'service_unavailable') {
    return existing;
  }

  const compiled = fileURLToPath(new URL('./main.js', import.meta.url));
  const entry = existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL('./main.ts', import.meta.url));
  const args = [
    ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []),
    entry,
    '--state-directory',
    stateDirectory,
    ...(options.gitExecutable ? ['--git-executable', options.gitExecutable] : []),
    ...(options.herdrExecutable ? ['--herdr-executable', options.herdrExecutable] : []),
    'service',
    'run',
  ];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });
  child.unref();

  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    await delay(150);
    const observed = await status();

    if (observed.outcome === 'completed') {
      return serviceStatusSchema.safeParse(observed.value).success
        ? { schemaVersion: 1, outcome: 'completed', value: { ready: true } }
        : rejected('service_protocol_error', 'Service returned an invalid status response.');
    }

    if (observed.outcome !== 'rejected') {
      return rejected('service_protocol_error', 'Service returned an invalid status response.');
    }

    if (!['service_unavailable', 'service_endpoint_unsafe'].includes(observed.error.code)) {
      return observed;
    }

    if (spawnFailed) {
      break;
    }
  }

  return rejected(
    'service_unavailable',
    'Astack could not start or contact its background service. Run astack service run to see the startup error.',
  );
}

export async function requestStartingService(
  stateDirectory: string,
  request: unknown,
  options: { gitExecutable?: string; herdrExecutable?: string } = {},
): Promise<ServiceRpcResponse> {
  const service = await ensureLocalService(stateDirectory, options);

  return service.outcome === 'rejected' ? service : requestLocalService(stateDirectory, request);
}
