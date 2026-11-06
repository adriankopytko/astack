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

  if (!role) {
    diagnostics.push(
      diagnostic('role_missing', 'Define the selected role in .astack/config.json.', snapshot.role),
    );

    return { input, diagnostics };
  }

  if (role.runtime === null) {
    diagnostics.push(
      diagnostic(
        'runtime_not_allowed',
        'Configure this agent with a provider, model and reasoning in .astack/config.json.',
        snapshot.role,
      ),
    );
  }

  const agent = policy.execution.agentSettings?.[snapshot.role];

  if (agent && agent.model === null) {
    diagnostics.push(
      diagnostic(
        'agent_model_missing',
        'Set the agent model in .astack/config.json.',
        snapshot.role,
      ),
    );
  }

  if (agent && agent.reasoning === null) {
    diagnostics.push(
      diagnostic(
        'agent_reasoning_missing',
        'Set the agent reasoning level in .astack/config.json.',
        snapshot.role,
      ),
    );
  }

  if (
    agent?.provider === 'codex' &&
    agent.reasoning !== null &&
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(agent.reasoning)
  ) {
    diagnostics.push(
      diagnostic(
        'agent_reasoning_unsupported',
        'Choose a supported Codex reasoning level: minimal, low, medium, high, xhigh or max.',
        snapshot.role,
      ),
    );
  }

  const commandIds = new Set([role.command]);

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
          'Define the command in execution.commands in .astack/config.json.',
          id,
        ),
      );
    } else {
      input.commands.push({ id, executable: command.executable });
    }
  }

  if (role.command === null && !agent) {
    diagnostics.push(
      diagnostic(
        'command_not_allowed',
        'Select a configured command for this role.',
        snapshot.role,
      ),
    );
  }

  for (const variable of new Set(role.environment)) {
    if (!policy.execution.allowedEnvironment.includes(variable)) {
      diagnostics.push(
        diagnostic(
          'environment_not_allowed',
          'Add this variable name to execution.allowedEnvironment in .astack/config.json.',
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
          'Add this skill version and digest to execution.skills in .astack/config.json.',
          skill.id,
        ),
      );
    } else {
      input.skills.push(approved);
    }
  }

  return { input, diagnostics };
}

/** Resolve project configuration and pin the effective settings in a snapshot. */
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
            'Fill .astack/config.json in the registered primary checkout; registration alone does not configure execution.',
          ),
        ],
      });
    }

    const parsed = hostConfigurationPolicySchema.safeParse(raw);

    if (!parsed.success) {
      return rejected(
        'configuration_invalid',
        'Project configuration does not match schemaVersion 1.',
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
    const snapshot = configurationSnapshotSchema.parse({
      schemaVersion: 1,
      projectId: project.project.id,
      repositoryId: project.repository.id,
      checkoutId: checkout.checkout.id,
      role: request.value.role,
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
          'Review the proposed settings and update the project configuration before accepting work.',
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

  if (!accepted.valid) {
    return accepted.result;
  }

  let policy: ReturnType<typeof hostConfigurationPolicySchema.safeParse>;

  try {
    policy = hostConfigurationPolicySchema.safeParse(
      await dependencies.configuration.readPolicy(job.projectId, signal),
    );
  } catch {
    return rejected('configuration_unavailable', 'Project configuration could not be read.');
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Job acceptance was cancelled before persistence.');
  }

  if (
    !policy.success ||
    configurationDigest(policy.data) !== resolution.value.snapshot.policyDigest
  ) {
    return rejected(
      'configuration_blocked',
      'Project configuration changed during job acceptance; retry the submission.',
    );
  }

  return dependencies.store.acceptJob(accepted.value, policy.data);
}

/** Read a job's private accepted configuration without reading the mutable project file. */
export async function readJobConfiguration(
  job: StateJob,
  reader: ConfigurationReader,
  signal?: AbortSignal,
): Promise<HostConfigurationPolicy | null> {
  if (!job.configuration) {
    return null;
  }

  const saved = await reader.readJobPolicy?.(job.id, signal);
  const parsed = hostConfigurationPolicySchema.safeParse(saved);

  if (
    !parsed.success ||
    parsed.data.projectId !== job.projectId ||
    parsed.data.repositoryId !== job.repositoryId ||
    configurationDigest(parsed.data) !== job.configuration.policyDigest
  ) {
    return null;
  }

  return parsed.data;
}

/** Recheck the assigned checkout and availability using the job's accepted settings. */
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

  try {
    const policy = await readJobConfiguration(parsed.value.job, dependencies.configuration, signal);

    if (signal?.aborted) {
      return rejected('cancelled', 'Dispatch configuration inspection was cancelled.');
    }

    if (!policy) {
      return completed({
        status: 'blocked',
        snapshot: saved,
        proposal: 'absent',
        diagnostics: [
          diagnostic(
            'snapshot_missing',
            'The saved job configuration is unavailable; submit a new job.',
          ),
        ],
      });
    }

    const selected = await selectProjectContext(
      { schemaVersion: 1, projectId: saved.projectId, checkoutId: saved.checkoutId },
      dependencies,
      signal,
    );

    if (selected.outcome === 'rejected') {
      return selected;
    }

    const checks = prerequisites(policy, saved);
    checks.diagnostics.push(...(await dependencies.prerequisites.inspect(checks.input, signal)));

    if (signal?.aborted) {
      return rejected('cancelled', 'Dispatch configuration inspection was cancelled.');
    }

    return completed({
      status: checks.diagnostics.length ? 'blocked' : 'ready',
      snapshot: saved,
      proposal: 'absent',
      diagnostics: checks.diagnostics,
    });
  } catch {
    return rejected(
      'configuration_unavailable',
      'The saved job configuration could not be inspected.',
    );
  }
}
