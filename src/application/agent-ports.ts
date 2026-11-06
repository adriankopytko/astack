import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import { allocationId } from '../core/allocation.js';
import type { ConfigurationReader } from '../ports/configuration.js';
import type { AllocationStore } from '../ports/resources.js';
import type { AllocationRequest } from '../contracts/resources.js';

export function createAgentPorts(deps: {
  configuration: ConfigurationReader;
  allocations: AllocationStore;
}) {
  async function requests(
    jobId: string,
    attemptId: string,
    role: string,
    signal?: AbortSignal,
  ): Promise<OperationResult<AllocationRequest[]>> {
    const policy = hostConfigurationPolicySchema.safeParse(
      await deps.configuration.readJobPolicy?.(jobId, signal),
    );

    if (!policy.success) {
      return rejected('configuration_blocked', 'The accepted job configuration is unavailable.');
    }

    return completed(
      Object.entries(policy.data.execution.agentSettings?.[role]?.ports ?? {}).map(
        ([key, spec]) => ({
          schemaVersion: 1 as const,
          jobId,
          attemptId,
          key,
          spec: {
            kind: 'managed-port' as const,
            protocol: 'tcp' as const,
            host: '127.0.0.1' as const,
            range: 'fixed' in spec ? [spec.fixed, spec.fixed] : spec.range,
          },
        }),
      ),
    );
  }

  return {
    async environment(
      jobId: string,
      attemptId: string,
      role: string,
      signal?: AbortSignal,
      allocate = true,
    ): Promise<OperationResult<Record<string, string>>> {
      const desired = await requests(jobId, attemptId, role, signal);

      if (desired.outcome === 'rejected') {
        return desired;
      }

      const environment: Record<string, string> = {};

      for (const request of desired.value) {
        const allocation = allocate
          ? deps.allocations.reserve(request)
          : deps.allocations.inspect(allocationId(request));

        if (!allocate && allocation.outcome === 'completed' && allocation.value === null) {
          continue;
        }

        if (
          (allocation.outcome !== 'persisted' && allocation.outcome !== 'completed') ||
          !allocation.value ||
          (allocation.value.phase !== 'reserved' &&
            (allocate || allocation.value.phase !== 'released')) ||
          allocation.value.value.kind !== 'port'
        ) {
          return rejected(
            'resource_blocked',
            'A configured port could not be reserved; inspect the job allocations.',
          );
        }

        if (allocation.value.phase !== 'released') {
          environment[request.key] = String(allocation.value.value.port);
        }
      }

      return completed(environment);
    },
    async release(
      jobId: string,
      attemptId: string,
      role: string,
      signal?: AbortSignal,
    ): Promise<OperationResult<null>> {
      const desired = await requests(jobId, attemptId, role, signal);

      if (desired.outcome === 'rejected') {
        return desired;
      }

      for (const request of desired.value) {
        const record = deps.allocations.inspect(allocationId(request));

        if (record.outcome === 'rejected') {
          return record;
        }

        if (record.value) {
          const released = deps.allocations.releaseManaged({ id: record.value.id, attemptId });

          if (released.outcome !== 'persisted') {
            return rejected('resource_blocked', 'An assigned port could not be released.');
          }
        }
      }

      return completed(null);
    },
  };
}
