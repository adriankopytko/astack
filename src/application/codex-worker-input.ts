import { completed, rejected } from '../contracts/operation-result.js';
import type { WorkerInput } from '../ports/task-delivery.js';
import { inputRuntime, type RuntimeDependencies } from './runtime.js';

/** Composition bridge: workflow policy stays generic, while this runtime enforces its own native binding. */
export function createCodexWorkerInput(deps: RuntimeDependencies): WorkerInput {
  return {
    receipt({ attemptId, key }) {
      const result = deps.runtime.action(attemptId, key);

      if (result.outcome === 'rejected' || result.value === null) {
        return result;
      }

      const action = result.value;

      return action.kind === 'input'
        ? completed({ key: action.key, digest: action.digest, state: action.state })
        : rejected('runtime_conflict', 'The worker input key identifies a different action kind.');
    },
    async submit(input, signal) {
      const result = await inputRuntime({ schemaVersion: 1, ...input }, deps, signal);

      if (result.outcome === 'rejected') {
        return result;
      }

      const status = result.value;
      const action = status.action;
      const receipt = action
        ? { key: action.key, digest: action.digest, state: action.state }
        : null;
      const blocker =
        status.state === 'running'
          ? null
          : status.reason === 'agent_blocked'
            ? 'needs_decision'
            : status.reason === 'agent_busy'
              ? 'busy'
              : status.reason === 'identity_changed'
                ? 'identity_changed'
                : 'provider_unavailable';

      return completed({ receipt, blocker });
    },
  };
}
