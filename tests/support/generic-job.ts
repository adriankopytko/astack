import assert from 'node:assert/strict';
import {
  submitGenericHandoff,
  createGenericHandoffRuntime,
} from '../../src/application/generic-handoff.js';
import type { GenericHandoffTask } from '../../src/contracts/generic-handoff.js';
import type { RunDependencies } from '../../src/application/runs.js';
import { fixture } from './task.js';

export type FixtureContext = Parameters<Parameters<typeof fixture>[0]>[0];

export function genericRuntime(context: FixtureContext) {
  return createGenericHandoffRuntime({
    runtime: context.base,
    dependencies: context.deps,
    workerInput: context.workerInput,
  });
}

export async function submitFixture(
  context: FixtureContext,
  request: GenericHandoffTask['submission'],
  dependencies: RunDependencies | FixtureContext['deps'],
) {
  const worktree = context.context.opened.worktrees.forCheckout(request.checkoutId);

  assert.ok(worktree.outcome === 'completed' && worktree.value);

  const root = worktree.value.intent.checkoutPath;
  const instructions = await context.deps.instructions.read({
    root,
    paths: request.instructionPaths,
  });

  assert.ok(instructions.outcome === 'completed');

  return submitGenericHandoff(
    {
      schemaVersion: 1,
      workflow: 'handoff',
      submission: request,
      worktreeId: worktree.value.intent.id,
      root,
      instructions: instructions.value,
      stateDirectory: context.context.state,
    },
    dependencies,
  );
}
