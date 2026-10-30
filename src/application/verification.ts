import { isDeepStrictEqual } from 'node:util';
import {
  verificationRequestSchema,
  verificationRecordSchema,
  verificationSelectorSchema,
  verificationReconcileSchema,
  verificationAuthorizationSchema,
  type VerificationRecord,
} from '../contracts/verification.js';
import {
  hostConfigurationPolicySchema,
  portableConfigurationSchema,
} from '../contracts/configuration.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { VerificationStore } from '../ports/verification.js';
import type { ConfigurationReader } from '../ports/configuration.js';
import { configurationDigest } from '../core/configuration.js';
import { verificationSelection } from '../core/verification.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import {
  inspectCompletedImplementation,
  CompletedImplementationFailure,
  type CompletedImplementationDependencies,
} from './completed-implementation.js';
import { executeHook, type HookDependencies } from './hooks.js';
import { checkConfigurationDispatch } from './configuration.js';
export interface VerificationDependencies
  extends HookDependencies, CompletedImplementationDependencies {
  verifications: VerificationStore;
}
class VerificationFailure extends Error {
  constructor(readonly result: ReturnType<typeof rejected>) {
    super('Verification prerequisites unavailable');
  }
}
function take<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new VerificationFailure(result);
  }

  return result.value;
}

function fail(message: string): never {
  throw new VerificationFailure(rejected('verification_blocked', message));
}

export function inspectImplementationVerification(
  input: unknown,
  deps: Pick<VerificationDependencies, 'verifications'>,
) {
  const parsed = parseOperationRequest(verificationSelectorSchema, input);

  return parsed.valid ? deps.verifications.read(parsed.value.id) : parsed.result;
}

export function reconcileImplementationVerification(
  input: unknown,
  deps: Pick<VerificationDependencies, 'verifications'>,
) {
  const parsed = parseOperationRequest(verificationReconcileSchema, input);

  return parsed.valid ? deps.verifications.reconcile(parsed.value) : parsed.result;
}

/** Read-only current host policy plus durable executed proof. Handoff separately rechecks Git/artifacts. */
export async function checkImplementationVerification(
  input: unknown,
  deps: { verifications: VerificationStore; configuration: ConfigurationReader },
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(verificationAuthorizationSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const r = parsed.value;
    const record = take(deps.verifications.authorize(r.id, r.source, r.jobId, r.reportId));
    const policy = hostConfigurationPolicySchema.parse(
      await deps.configuration.readPolicy(record.source.projectId, signal),
    );
    const selection = verificationSelection(policy, record.role, record.request);
    const rawProposal = await deps.configuration.readProposal(record.source.root, signal);

    if (rawProposal !== null) {
      const proposal = portableConfigurationSchema.safeParse(rawProposal);

      if (
        !proposal.success ||
        configurationDigest(proposal.data.settings) !== configurationDigest(policy.project)
      ) {
        fail('Repository configuration no longer matches the host-approved baseline.');
      }
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Verification authorization was cancelled.');
    }

    if (
      !policy.execution.enabled ||
      policy.projectId !== record.source.projectId ||
      policy.repositoryId !== record.source.repositoryId ||
      configurationDigest(policy) !== record.policyDigest ||
      !selection ||
      selection.digest !== record.selectionDigest ||
      selection.maxAgeMs !== record.maxAgeMs
    ) {
      fail(
        'Executed verification no longer matches the approved role policy; inspect configuration before another publication.',
      );
    }

    return deps.verifications.authorize(r.id, r.source, r.jobId, r.reportId);
  } catch (error) {
    return error instanceof VerificationFailure
      ? error.result
      : rejected(
          'verification_blocked',
          'Approved verification policy/evidence is missing or changed.',
        );
  }
}

/** Explicit host invocation; original controllers/writers remain excluded throughout checks and drain. */
export async function verifyImplementation(
  input: unknown,
  deps: VerificationDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<VerificationRecord>> {
  const parsed = parseOperationRequest(verificationRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Verification cancelled before intent.');
  }

  const request = parsed.value;
  let current: VerificationRecord | null = null;
  const update = (record: VerificationRecord) => {
    const result = deps.verifications.update(
      { ...record, revision: record.revision + 1, updatedAt: deps.now() },
      record.revision,
    );

    if (result.outcome === 'persisted') {
      current = result.value;
    }

    return result;
  };

  try {
    const id = `verification-${configurationDigest({ jobId: request.jobId, key: request.key })}`;
    const old = take(deps.verifications.read(id));

    if (old) {
      if (!isDeepStrictEqual(old.request, request)) {
        return rejected('state_conflict', 'Verification key identifies another immutable request.');
      }

      return { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: old };
    }

    const inspected = await inspectCompletedImplementation(request, deps, signal);
    const ready = take(
      await checkConfigurationDispatch({ schemaVersion: 1, job: inspected.job.job }, deps, signal),
    );

    if (ready.status !== 'ready' || !ready.snapshot) {
      fail('Restore the accepted role policy and prerequisites before verification.');
    }

    const policy = hostConfigurationPolicySchema.parse(
      await deps.configuration.readPolicy(inspected.source.projectId, signal),
    );

    if (configurationDigest(policy) !== ready.snapshot.policyDigest) {
      fail('Host policy changed during verification planning.');
    }

    const selection = verificationSelection(policy, ready.snapshot.role, request);

    if (!selection) {
      fail(
        'Configure execution.verification for this role with named baseline checks, valid selected lanes/additional checks and maxAgeMs.',
      );
    }

    const required = new Set(
      selection.checks.flatMap((c) =>
        Object.values(
          policy.execution.verification![ready.snapshot!.role]!.checks[c.name]!.resources,
        ).map((r) => r.key),
      ),
    );
    const allocations = request.allocations.map((ref) => {
      const allocation = take(deps.allocations.inspect(ref.id));

      if (
        !allocation ||
        allocation.request.jobId !== request.jobId ||
        allocation.request.attemptId !== inspected.source.attemptId ||
        allocation.revision !== ref.expectedRevision ||
        !required.has(allocation.request.key)
      ) {
        fail('Select the exact owned verification resource keys and revisions.');
      }

      return allocation;
    });

    if (allocations.length !== required.size) {
      fail('Supply precisely the resource inputs required by the selected checks.');
    }

    const timestamp = deps.now();
    const record = verificationRecordSchema.parse({
      schemaVersion: 1,
      id,
      request,
      source: inspected.source,
      location: inspected.location,
      artifacts: inspected.artifacts,
      role: ready.snapshot.role,
      reportDigest: inspected.reportDigest,
      policyDigest: ready.snapshot.policyDigest,
      selectionDigest: selection.digest,
      maxAgeMs: selection.maxAgeMs,
      checks: selection.checks.map((c) => ({
        ...c,
        hookKey: `verify-check-${configurationDigest({ id, name: c.name })}`,
        hookId: null,
        hookRevision: null,
        resultDigest: null,
        outcome: 'not_run',
      })),
      status: 'prepared',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      verifiedAt: null,
      expiresAt: null,
      reason: null,
      reconciliation: null,
    });
    const prepared = deps.verifications.prepare(record);

    if (prepared.outcome !== 'persisted' || prepared.disposition !== 'created') {
      return prepared;
    }

    current = prepared.value;
    const claimed = update({ ...current, status: 'running' });

    if (claimed.outcome !== 'persisted') {
      return claimed;
    }

    for (let index = 0; index < current.checks.length; index++) {
      if (signal?.aborted) {
        return update({ ...current, status: 'cancelled', reason: 'cancelled' });
      }

      const check = current.checks[index]!;
      const hookId = `hook-${configurationDigest({ attemptId: current.source.attemptId, key: check.hookKey })}`;
      const marked = update({
        ...current,
        checks: current.checks.map((c, i) =>
          i === index ? { ...c, outcome: 'unknown', hookId } : c,
        ),
      });

      if (marked.outcome !== 'persisted') {
        return marked;
      }

      const definition = policy.execution.verification![current.role]!.checks[check.name]!;
      const keys = new Set(Object.values(definition.resources).map((r) => r.key));
      const refs = request.allocations.filter((ref) =>
        keys.has(allocations.find((a) => a.id === ref.id)!.request.key),
      );
      const result = await executeHook(
        {
          schemaVersion: 1,
          jobId: request.jobId,
          attemptId: current.source.attemptId,
          key: check.hookKey,
          phase: 'verify',
          verificationCheck: check.name,
          commit: current.source.headCommit,
          allocations: refs,
          writersExcluded: true,
        },
        deps,
        signal,
      );
      const hook = result.outcome === 'persisted' ? result.value : null;

      if (result.outcome === 'persisted' && result.disposition === 'existing') {
        return update({ ...current, status: 'unknown', reason: 'execution_uncertain' });
      }

      const outcome =
        hook?.status === 'succeeded'
          ? 'passed'
          : hook?.status === 'cancelled' || signal?.aborted
            ? 'cancelled'
            : hook?.status === 'failed' || result.outcome === 'rejected'
              ? 'failed'
              : 'unknown';
      const stored = update({
        ...current,
        checks: current.checks.map((c, i) =>
          i === index
            ? {
                ...c,
                outcome,
                hookRevision: hook?.revision ?? null,
                resultDigest: hook?.result ? configurationDigest(hook.result) : null,
              }
            : c,
        ),
      });

      if (stored.outcome !== 'persisted') {
        return stored;
      }

      if (outcome !== 'passed') {
        return update({
          ...current,
          status:
            outcome === 'unknown' ? 'unknown' : outcome === 'cancelled' ? 'cancelled' : 'failed',
          reason:
            outcome === 'unknown'
              ? 'execution_uncertain'
              : outcome === 'cancelled'
                ? 'cancelled'
                : 'check_failed',
        });
      }
    }

    const after = await inspectCompletedImplementation(request, deps, signal);

    if (
      !isDeepStrictEqual(after.source, current.source) ||
      !isDeepStrictEqual(after.location, current.location) ||
      after.reportDigest !== current.reportDigest ||
      !isDeepStrictEqual(after.artifacts, current.artifacts)
    ) {
      return update({ ...current, status: 'invalidated', reason: 'source_changed' });
    }

    const finalPolicy = hostConfigurationPolicySchema.parse(
      await deps.configuration.readPolicy(current.source.projectId, signal),
    );

    if (configurationDigest(finalPolicy) !== current.policyDigest) {
      return update({ ...current, status: 'invalidated', reason: 'policy_changed' });
    }

    if (signal?.aborted) {
      return update({ ...current, status: 'cancelled', reason: 'cancelled' });
    }

    const verifiedAt = deps.now();

    return update({
      ...current,
      status: 'passed',
      verifiedAt,
      expiresAt: verifiedAt + current.maxAgeMs,
    });
  } catch (error) {
    if (current) {
      return update({
        ...current,
        status: signal?.aborted
          ? 'cancelled'
          : error instanceof CompletedImplementationFailure
            ? 'invalidated'
            : 'unknown',
        reason: signal?.aborted
          ? 'cancelled'
          : error instanceof CompletedImplementationFailure
            ? 'source_changed'
            : 'execution_uncertain',
      });
    }

    return error instanceof VerificationFailure || error instanceof CompletedImplementationFailure
      ? error.result
      : rejected(
          'verification_blocked',
          'Verification prerequisites could not be inspected; no checks were authorized.',
        );
  }
}
