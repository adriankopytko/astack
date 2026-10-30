import { verificationApproval, VerificationApprovalError } from '../core/verification.js';
import { z } from 'zod';
import {
  configurationRequestSchema,
  configurationSnapshotSchema,
  hostConfigurationPolicySchema,
  portableConfigurationSchema,
  type ConfigurationDiagnostic,
  type ConfigurationResolution,
  type ConfigurationSnapshot,
  type HostConfigurationPolicy,
} from '../contracts/configuration.js';
import {
  stateJobRequestSchema,
  configuredJobRequestSchema,
  type StateJob,
  type StateWriteResult,
} from '../contracts/state.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { configurationDigest, mergeConfiguration } from '../core/configuration.js';
import { ConfigurationReadError } from '../core/configuration-error.js';
import type {
  ConfigurationReader,
  ConfigurationProbe,
  ConfigurationPrerequisites,
} from '../ports/configuration.js';
import type { StateStore } from '../ports/state-store.js';
import type { ProjectDependencies } from './project-facts.js';
import { selectProjectContext } from './select-project-context.js';

export interface ConfigurationDependencies extends ProjectDependencies {
  configuration: ConfigurationReader;
  prerequisites: ConfigurationProbe;
}

function diagnostic(
  code: ConfigurationDiagnostic['code'],
  nextStep: string,
  subject?: string,
): ConfigurationDiagnostic {
  return { code, nextStep, ...(subject === undefined ? {} : { subject }) };
}

function prerequisites(
  policy: HostConfigurationPolicy,
  snapshot: ConfigurationSnapshot,
): { input: ConfigurationPrerequisites; diagnostics: ConfigurationDiagnostic[] } {
  const diagnostics: ConfigurationDiagnostic[] = [];
  const input: ConfigurationPrerequisites = { commands: [], skills: [], environment: [] };
  const role = Object.hasOwn(snapshot.effective.roles, snapshot.role)
    ? snapshot.effective.roles[snapshot.role]
    : undefined;

  if (!policy.execution.enabled) {
    diagnostics.push(
      diagnostic(
        'execution_disabled',
        'Enable execution in the trusted host policy before accepting work.',
      ),
    );
  }

  if (!role) {
    diagnostics.push(
      diagnostic(
        'role_missing',
        'Define the selected role in the approved settings.',
        snapshot.role,
      ),
    );

    return { input, diagnostics };
  }

  if (role.runtime === null || !policy.execution.allowedRuntimes.includes(role.runtime)) {
    diagnostics.push(
      diagnostic(
        'runtime_not_allowed',
        'Approve the selected runtime in host policy.',
        snapshot.role,
      ),
    );
  }

  if (role.timeoutMs > policy.execution.maxTimeoutMs) {
    diagnostics.push(
      diagnostic(
        'timeout_not_allowed',
        'Reduce the requested timeout or explicitly raise the host limit.',
        snapshot.role,
      ),
    );
  }

  for (const hook of ['setup', 'verify', 'teardown', 'start'] as const) {
    const required = policy.execution.requiredHooks[hook];

    if (required != null && snapshot.effective.hooks[hook] !== required) {
      diagnostics.push(
        diagnostic(
          'required_hook_changed',
          'Restore the mandatory hook selected by host policy.',
          hook,
        ),
      );
    }
  }

  const commandIds = new Set([role.command, ...Object.values(snapshot.effective.hooks)]);

  for (const id of commandIds) {
    if (id == null) {
      continue;
    }

    const command = Object.hasOwn(policy.execution.commands, id)
      ? policy.execution.commands[id]
      : undefined;

    if (!command) {
      diagnostics.push(
        diagnostic(
          'command_not_allowed',
          'Define the command in trusted host execution policy.',
          id,
        ),
      );
    } else {
      input.commands.push({ id, executable: command.executable });
    }
  }

  if (role.command === null) {
    diagnostics.push(
      diagnostic('command_not_allowed', 'Select an approved command for this role.', snapshot.role),
    );
  }

  for (const variable of new Set(role.environment)) {
    if (!policy.execution.allowedEnvironment.includes(variable)) {
      diagnostics.push(
        diagnostic(
          'environment_not_allowed',
          'Approve this environment variable name in host policy.',
          variable,
        ),
      );
    } else {
      input.environment.push(variable);
    }
  }

  for (const skill of role.skills) {
    const approved = policy.execution.skills.find(
      (entry) =>
        entry.id === skill.id && entry.version === skill.version && entry.digest === skill.digest,
    );

    if (!approved) {
      diagnostics.push(
        diagnostic(
          'skill_not_approved',
          'Approve this exact skill version and digest in host policy.',
          skill.id,
        ),
      );
    } else {
      input.skills.push(approved);
    }
  }

  return { input, diagnostics };
}

/** Resolve only host-approved layers. Repository bytes are a proposal, never execution authority. */
export async function resolveConfiguration(
  input: unknown,
  dependencies: ConfigurationDependencies,
  signal?: AbortSignal,
): Promise<OperationResult<ConfigurationResolution>> {
  const request = parseOperationRequest(configurationRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const selected = await selectProjectContext(
    {
      schemaVersion: 1,
      projectId: request.value.projectId,
      ...(request.value.checkoutId === undefined ? {} : { checkoutId: request.value.checkoutId }),
    },
    dependencies,
    signal,
  );

  if (selected.outcome === 'rejected') {
    return selected;
  }

  const { project, checkout } = selected.value;

  if (selected.value.registration !== 'registered' || !project || !checkout) {
    return rejected(
      'checkout_not_found',
      'Configuration requires an explicitly registered project checkout.',
    );
  }

  try {
    const raw = await dependencies.configuration.readPolicy(project.project.id, signal);

    if (signal?.aborted) {
      return rejected('cancelled', 'Configuration inspection was cancelled.');
    }

    if (raw === null) {
      return completed({
        status: 'blocked',
        snapshot: null,
        proposal: 'not_checked',
        diagnostics: [
          diagnostic(
            'policy_missing',
            'Create a private host policy for this registered project; registration alone grants no execution permission.',
          ),
        ],
      });
    }

    const parsed = hostConfigurationPolicySchema.safeParse(raw);

    if (!parsed.success) {
      return rejected(
        'configuration_invalid',
        'Host policy does not match configuration schemaVersion 1.',
      );
    }

    const policy = parsed.data;

    if (policy.projectId !== project.project.id || policy.repositoryId !== project.repository.id) {
      return rejected(
        'project_selector_conflict',
        'Host policy belongs to a different project or repository.',
      );
    }

    const proposalBytes = await dependencies.configuration.readProposal(
      checkout.checkout.rootPath,
      signal,
    );
    const proposal =
      proposalBytes === null ? null : portableConfigurationSchema.safeParse(proposalBytes);

    if (proposal && !proposal.success) {
      return rejected(
        'configuration_invalid',
        'Repository proposal does not match portable configuration schemaVersion 1; host permissions are not portable settings.',
      );
    }

    const merged = mergeConfiguration({
      user: policy.user,
      project: policy.project,
      local: policy.local,
      request: request.value.request,
    });
    const role = Object.hasOwn(merged.effective.roles, request.value.role)
      ? merged.effective.roles[request.value.role]
      : undefined;
    const approvedVerification = verificationApproval(policy, request.value.role);
    const snapshot = configurationSnapshotSchema.parse({
      schemaVersion: 1,
      projectId: project.project.id,
      repositoryId: project.repository.id,
      checkoutId: checkout.checkout.id,
      role: request.value.role,
      policyRevision: policy.revision,
      ...(approvedVerification ? { verification: approvedVerification } : {}),
      policyDigest: configurationDigest(policy),
      effectiveDigest: configurationDigest(merged.effective),
      ...merged,
      request: request.value.request,
      skills: role?.skills ?? [],
    });
    const checks = prerequisites(policy, snapshot);
    const proposalStatus = proposal?.success
      ? configurationDigest(proposal.data.settings) === configurationDigest(policy.project)
        ? 'matches'
        : 'changed'
      : 'absent';

    if (proposalStatus === 'changed') {
      checks.diagnostics.push(
        diagnostic(
          'proposal_changed',
          'Review the repository proposal and explicitly update the host-approved project baseline before accepting work.',
        ),
      );
    }

    checks.diagnostics.push(...(await dependencies.prerequisites.inspect(checks.input, signal)));

    if (signal?.aborted) {
      return rejected('cancelled', 'Configuration inspection was cancelled.');
    }

    // Recheck the selected checkout after asynchronous configuration/prerequisite reads.
    const fresh = await selectProjectContext(
      { schemaVersion: 1, projectId: snapshot.projectId, checkoutId: snapshot.checkoutId },
      dependencies,
      signal,
    );

    if (fresh.outcome === 'rejected') {
      return fresh;
    }

    return completed({
      status: checks.diagnostics.length ? 'blocked' : 'ready',
      snapshot,
      proposal: proposalStatus,
      diagnostics: checks.diagnostics,
    });
  } catch (error) {
    if (signal?.aborted) {
      return rejected('cancelled', 'Configuration inspection was cancelled.');
    }

    if (error instanceof VerificationApprovalError) {
      return rejected('configuration_invalid', error.message);
    }

    if (error instanceof z.ZodError) {
      return rejected(
        'configuration_invalid',
        'Combined configuration exceeds the supported schema or size limits.',
      );
    }

    return error instanceof ConfigurationReadError
      ? rejected(error.code, error.message)
      : rejected(
          'configuration_unavailable',
          'Configuration could not be inspected; check trusted files and retry the read.',
        );
  }
}

/** Store the exact resolved policy and skill pins in the same job acceptance transaction. */
export async function acceptConfiguredJob(
  input: unknown,
  dependencies: ConfigurationDependencies & { store: StateStore },
  signal?: AbortSignal,
): Promise<StateWriteResult<StateJob>> {
  const parsed = parseOperationRequest(configuredJobRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const job = parsed.value.job;

  if (job.configuration !== undefined) {
    return rejected(
      'invalid_request',
      'Job configuration is resolved by the trusted host, not supplied by the requester.',
    );
  }

  const resolution = await resolveConfiguration(
    {
      schemaVersion: 1,
      projectId: job.projectId,
      checkoutId: job.checkoutId,
      role: parsed.value.role,
      request: parsed.value.request,
    },
    dependencies,
    signal,
  );

  if (resolution.outcome === 'rejected') {
    return resolution;
  }

  if (resolution.value.status !== 'ready' || !resolution.value.snapshot) {
    return rejected(
      'configuration_blocked',
      'Inspect configuration diagnostics and resolve prerequisites before accepting this job.',
    );
  }

  if (job.repositoryId !== resolution.value.snapshot.repositoryId) {
    return rejected(
      'project_selector_conflict',
      'Job repository and approved configuration must agree.',
    );
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Job acceptance was cancelled before persistence.');
  }

  const accepted = parseOperationRequest(stateJobRequestSchema, {
    schemaVersion: 1,
    job: { ...job, configuration: resolution.value.snapshot },
  });

  return accepted.valid ? dependencies.store.acceptJob(accepted.value) : accepted.result;
}

/** A dispatch gate, not a dispatcher: refresh revocation, executables, environment, skills and checkout. */
export async function checkConfigurationDispatch(
  input: unknown,
  dependencies: ConfigurationDependencies,
  signal?: AbortSignal,
): Promise<OperationResult<ConfigurationResolution>> {
  const parsed = parseOperationRequest(stateJobRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Dispatch configuration inspection was cancelled.');
  }

  const saved = parsed.value.job.configuration;

  if (!saved) {
    return completed({
      status: 'blocked',
      snapshot: null,
      proposal: 'not_checked',
      diagnostics: [
        diagnostic(
          'snapshot_missing',
          'Accept a new job with an approved configuration snapshot; legacy jobs cannot dispatch automatically.',
        ),
      ],
    });
  }

  const current = await resolveConfiguration(
    {
      schemaVersion: 1,
      projectId: saved.projectId,
      checkoutId: saved.checkoutId,
      role: saved.role,
      request: saved.request,
    },
    dependencies,
    signal,
  );

  if (current.outcome === 'rejected') {
    return current;
  }

  if (configurationDigest(current.value.snapshot) !== configurationDigest(saved)) {
    return completed({
      ...current.value,
      status: 'blocked',
      diagnostics: [
        ...current.value.diagnostics,
        diagnostic(
          'policy_changed',
          'Re-evaluate the changed host policy and accept a new job; the saved job policy is immutable.',
        ),
      ],
    });
  }

  return current;
}
