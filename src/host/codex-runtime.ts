import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createCodexHerdrRuntime } from '../application/runtime.js';
import { createHerdrCliProvider } from '../adapters/herdr/cli-provider.js';
import { nodeHerdrEndpointReader } from '../adapters/filesystem/herdr-endpoint.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import type { StateOpenResult } from '../adapters/state/open-sqlite-state.js';
import type { ServiceDependencies } from '../application/service.js';

/** Host opt-in accepts the selected server's shell, canonical Codex resolution and ambient agent configuration. */
export function composeCodexHerdrRuntime(input: {
  opened: Extract<StateOpenResult, { outcome: 'opened' }>;
  dependencies: ServiceDependencies;
  herdrExecutable: string;
  codexExecutable: string;
}) {
  const provider = createHerdrCliProvider({
    executable: input.herdrExecutable,
    runner: nodeProcessRunner,
    endpoint: nodeHerdrEndpointReader,
  });

  return createCodexHerdrRuntime({
    ...input.dependencies,
    state: input.opened.store,
    herdr: input.opened.herdr,
    runtime: input.opened.runtime,
    provider,
    worker: provider,
    canonicalCodexExecutable: input.codexExecutable,
    files: createNodeWorktreeFiles(join(input.opened.stateDirectory, 'worktrees')),
    newId: () => randomUUID(),
  });
}
