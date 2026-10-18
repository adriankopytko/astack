import { completed } from '../contracts/operation-result.js';
import type { RunWorkerControl } from '../ports/runs.js';
import { interruptRuntime, type RuntimeDependencies } from './runtime.js';
/** Native identity/policy and durable action keys remain enforced by the existing runtime. */
export function createCodexRunControl(deps: RuntimeDependencies): RunWorkerControl {
  return {
    async interrupt(input, signal) {
      const result = await interruptRuntime({ schemaVersion: 1, ...input }, deps, signal);

      if (result.outcome === 'rejected') {
        return result;
      }

      const value = result.value;

      return completed({
        state:
          value.action?.state === 'acknowledged'
            ? ('acknowledged' as const)
            : value.action?.state === 'pending' || value.state === 'unknown'
              ? ('unknown' as const)
              : ('blocked' as const),
      });
    },
  };
}
