import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createCodexHerdrRuntime } from '../application/runtime.js';
import { createReviewRuntime, type ReviewDependencies } from '../application/review.js';
import { createImplementationRuntime } from '../application/implementation.js';
import { createCodexImplementationInput } from '../application/codex-implementation-input.js';
import { nodeImplementationContextReader } from '../adapters/filesystem/implementation-context.js';
import type { RuntimeDependencies } from '../application/runtime.js';
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
  reviewDependencies: ReviewDependencies;
  herdrExecutable: string;
  codexExecutable: string;
}) {
  const provider = createHerdrCliProvider({
    executable: input.herdrExecutable,
    runner: nodeProcessRunner,
    endpoint: nodeHerdrEndpointReader,
  });

  const dependencies: RuntimeDependencies = {
    ...input.dependencies,
    state: input.opened.store,
    herdr: input.opened.herdr,
    runtime: input.opened.runtime,
    provider,
    worker: provider,
    canonicalCodexExecutable: input.codexExecutable,
    files: createNodeWorktreeFiles(join(input.opened.stateDirectory, 'worktrees')),
    newId: () => randomUUID(),
  };

  const implementation = createImplementationRuntime({
    runtime: createCodexHerdrRuntime(dependencies),
    dependencies: {
      ...input.dependencies,
      worktrees: input.opened.worktrees,
      files: dependencies.files,
      instructions: nodeImplementationContextReader,
    },
    workerInput: createCodexImplementationInput(dependencies),
  });

  return createReviewRuntime({
    runtime: implementation,
    dependencies: input.reviewDependencies,
    workerInput: createCodexImplementationInput(dependencies),
  });
}
