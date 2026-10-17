import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [entry, state, git, mode] = process.argv.slice(2);

if (!entry || !state || !git || !mode) {
  throw new Error('Missing fixture arguments');
}

/** @type {typeof import('../../src/index.js')} */
const api = /** @type {typeof import('../../src/index.js')} */ (
  /** @type {unknown} */ (await import(pathToFileURL(entry).href))
);
/** @type {import('../../src/index.js').ServiceWorkerRuntime} */
const runtime = {
  id: 'fixture',
  async start(job) {
    if (mode === 'crash-before') {
      process.exit(72);
    }

    await writeFile(
      join(state, `fixture-effect-${job.attempt.id}.json`),
      JSON.stringify({ attempt: job.attempt.id }),
      { flag: 'wx', mode: 0o600 },
    );

    if (mode === 'crash-after') {
      process.exit(71);
    }

    return { state: 'running', handle: { id: job.attempt.id }, evidence: { fixture: true } };
  },
  async inspect(job) {
    try {
      await readFile(join(state, `fixture-effect-${job.attempt.id}.json`));

      return { state: 'running', handle: { id: job.attempt.id }, evidence: { inspected: true } };
    } catch {
      return { state: 'unknown', handle: null, evidence: { absentDoesNotProveUnstarted: true } };
    }
  },
};
const service = await api.startLocalService(
  { schemaVersion: 1, stateDirectory: state, gitExecutable: git },
  { runtimes: [runtime] },
);

if (service.outcome !== 'listening') {
  process.stdout.write(`${JSON.stringify(service)}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ outcome: 'listening', path: service.socketPath })}\n`);
const stop = () => {
  void service.close();
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await service.closed;
