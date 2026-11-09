import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { ensureLocalService } from './ensure-service.js';

/** Start the coordinator to migrate an older state database before a submission. */
export async function openSubmissionState(
  host: { stateDirectory?: string; gitExecutable?: string; herdrExecutable?: string },
  startService: boolean,
) {
  const directory =
    host.stateDirectory === undefined
      ? join(homedir(), '.astack')
      : resolve(process.cwd(), host.stateDirectory);
  let state = await openSqliteState({
    schemaVersion: 1,
    mode: 'read-only',
    stateDirectory: directory,
  });

  if (
    startService &&
    state.outcome === 'rejected' &&
    state.error.code === 'state_schema_mismatch'
  ) {
    let canonical: string;

    try {
      canonical = await realpath(directory);
    } catch {
      return state;
    }

    const service = await ensureLocalService(canonical, host);

    if (service.outcome === 'rejected') {
      return service;
    }

    state = await openSqliteState({
      schemaVersion: 1,
      mode: 'read-only',
      stateDirectory: directory,
    });
  }

  return state;
}
