import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, stateDirectory, executable, mode, serialized] = process.argv.slice(2);

if (!entry || !stateDirectory || !executable || !mode || !serialized) {
  process.exit(2);
}

const api = /** @type {typeof import('../../src/index.js')} */ (
  await import(pathToFileURL(entry).href)
);
const opened = await api.openSqliteState({ schemaVersion: 1, stateDirectory });

if (opened.outcome !== 'opened') {
  process.exit(3);
}

const effects = api.createWorktreeGit({ executable, runner: api.nodeProcessRunner });
/** @type {import('../../src/index.js').WorktreeGit} */
const wrapped = {
  ...effects,
  async create(intent, signal) {
    await effects.create(intent, signal);
    process.exit(71);
  },
  async remove(intent, signal) {
    await effects.remove(intent, signal);
    process.exit(71);
  },
};
const managedRoot = join(stateDirectory, 'worktrees');
/** @type {import('../../src/index.js').WorktreeDependencies} */
const dependencies = {
  registry: opened.registry,
  store: opened.worktrees,
  git: api.createGitInspector({ executable, runner: api.nodeProcessRunner }),
  identity: api.nodeCheckoutIdentityReader,
  files: api.createNodeWorktreeFiles(managedRoot),
  managedRoot,
  effects: wrapped,
  now: Date.now,
  nextId: (kind) => `${kind}-${randomUUID()}`,
};
/** @type {unknown} */
const input = JSON.parse(serialized);

if (mode === 'create') {
  await api.prepareWorktree(input, dependencies);
} else {
  await api.removeWorktree(input, dependencies);
}

process.exit(4);
