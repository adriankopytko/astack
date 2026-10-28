import {
  allocationRequestSchema,
  allocationSelectorSchema,
  allocationRevisionSchema,
  allocationStartSchema,
  allocationRunningSchema,
  allocationReleaseSchema,
  allocationListSchema,
  type AllocationRecord,
} from '../contracts/resources.js';
import { completed, rejected } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { AllocationStore, PortProbe } from '../ports/resources.js';
export interface AllocationDependencies {
  allocations: AllocationStore;
  ports: PortProbe;
}

export function inspectAllocation(
  input: unknown,
  deps: Pick<AllocationDependencies, 'allocations'>,
) {
  const parsed = parseOperationRequest(allocationSelectorSchema, input);

  return parsed.valid ? deps.allocations.inspect(parsed.value.id) : parsed.result;
}

export function listAllocations(input: unknown, deps: Pick<AllocationDependencies, 'allocations'>) {
  const parsed = parseOperationRequest(allocationListSchema, input);

  return parsed.valid ? deps.allocations.list(parsed.value) : parsed.result;
}

async function probe(record: AllocationRecord, deps: AllocationDependencies, signal?: AbortSignal) {
  if (record.value.kind !== 'port') {
    return completed('free' as const);
  }

  try {
    return await deps.ports.inspect(record.value, signal);
  } catch {
    return rejected(
      'resource_probe_unavailable',
      'Port evidence is unavailable; retain the allocation.',
    );
  }
}

/** Reserves before probing. Bounded fallback is allowed only before any startup receipt exists. */
export async function reserveAllocation(
  input: unknown,
  deps: AllocationDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(allocationRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Allocation was cancelled before reservation.');
  }

  let result = deps.allocations.reserve(parsed.value);

  for (let count = 0; count < 16 && result.outcome === 'persisted'; count++) {
    const record = result.value;

    if (
      !['probing', 'blocked'].includes(record.phase) ||
      record.startup ||
      record.value.kind !== 'port'
    ) {
      return result;
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Allocation is retained; inspect it before continuing.');
    }

    if (record.phase === 'blocked' && record.probe === 'busy') {
      const next = deps.allocations.next({ id: record.id, expectedRevision: record.revision });

      if (!(next.outcome === 'rejected' && next.error.code === 'resource_conflict')) {
        result = next;

        continue;
      }
      // No alternatives remain. A read-only reprobe can recover a fixed port
      // whose unrelated listener has since stopped, without changing identity.
    }

    const observed = await probe(record, deps, signal);
    result = deps.allocations.probe({
      id: record.id,
      expectedRevision: record.revision,
      observation: observed.outcome === 'completed' ? observed.value : 'unknown',
    });

    if (
      result.outcome !== 'persisted' ||
      result.value.phase === 'reserved' ||
      result.value.probe !== 'busy'
    ) {
      return result;
    }

    // A busy candidate can advance without any project settings or listener being changed.
    const next = deps.allocations.next({
      id: result.value.id,
      expectedRevision: result.value.revision,
    });

    if (next.outcome !== 'persisted') {
      return next.outcome === 'rejected' && next.error.code === 'resource_conflict' ? result : next;
    }

    result = next;
  }

  return result;
}

export async function startAllocation(
  input: unknown,
  deps: AllocationDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(allocationStartSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Startup receipt was not requested.');
  }

  const read = deps.allocations.inspect(parsed.value.id);

  if (read.outcome === 'rejected') {
    return read;
  }

  if (!read.value) {
    return rejected('state_not_found', 'Allocation was not found.');
  }

  if (read.value.startup) {
    // Existing receipt is observation only, never another permission to start.
    return deps.allocations.start(parsed.value);
  }

  if (read.value.revision !== parsed.value.expectedRevision || read.value.phase !== 'reserved') {
    return rejected(
      'resource_blocked',
      'Inspect the current reserved allocation before requesting startup.',
    );
  }

  const observed = await probe(read.value, deps, signal);

  if (observed.outcome !== 'completed' || observed.value !== 'free' || signal?.aborted) {
    return deps.allocations.probe({
      id: read.value.id,
      expectedRevision: read.value.revision,
      observation:
        observed.outcome === 'completed' && !signal?.aborted ? observed.value : 'unknown',
    });
  }

  return deps.allocations.start(parsed.value);
}

export async function confirmAllocationRunning(
  input: unknown,
  deps: AllocationDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(allocationRunningSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Running evidence was not accepted.');
  }

  const read = deps.allocations.inspect(parsed.value.id);

  if (read.outcome === 'rejected') {
    return read;
  }

  if (!read.value) {
    return rejected('state_not_found', 'Allocation was not found.');
  }

  const observed = await probe(read.value, deps, signal);

  if (
    observed.outcome !== 'completed' ||
    (read.value.value.kind === 'port' && observed.value !== 'busy') ||
    signal?.aborted
  ) {
    return rejected(
      'resource_blocked',
      'The assigned endpoint is not observably bound; preserve the startup intent.',
    );
  }

  return deps.allocations.running(parsed.value);
}

export function retainAllocation(
  input: unknown,
  deps: Pick<AllocationDependencies, 'allocations'>,
) {
  const parsed = parseOperationRequest(allocationRevisionSchema, input);

  return parsed.valid ? deps.allocations.retain(parsed.value) : parsed.result;
}

/** Host excludes original startup/controllers/children and independently verifies owned services stopped. */
export async function releaseAllocation(
  input: unknown,
  deps: AllocationDependencies,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(allocationReleaseSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Allocation release was cancelled.');
  }

  const read = deps.allocations.inspect(parsed.value.id);

  if (read.outcome === 'rejected') {
    return read;
  }

  if (!read.value) {
    return rejected('state_not_found', 'Allocation was not found.');
  }

  if (read.value.phase === 'released') {
    return deps.allocations.release(parsed.value);
  }

  if (
    read.value.revision !== parsed.value.expectedRevision ||
    (read.value.startup?.key ?? null) !== parsed.value.startupKey
  ) {
    return rejected(
      'state_conflict',
      'Shutdown evidence must select the exact allocation revision and startup receipt.',
    );
  }

  const observed = await probe(read.value, deps, signal);

  if (observed.outcome !== 'completed' || observed.value !== 'free' || signal?.aborted) {
    return rejected(
      'resource_blocked',
      'The endpoint remains bound or unknown; retain its reservation and cleanup hold.',
    );
  }

  return deps.allocations.release(parsed.value);
}
