import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { projectIdSchema, repositoryIdSchema, checkoutIdSchema } from './project-context.js';
import { createOperationResultSchema } from './operation-result.js';

const name = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
const text = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes('\0'));
const hostPath = text.refine(isAbsolute);
const managedPortNumber = z.number().int().min(1024).max(65535);
const managedPortName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine((value) => !['PATH', 'HOME', 'SHELL'].includes(value) && !value.startsWith('HERDR_'));
export const configurationDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const configurationSkillSchema = z.strictObject({
  id: name,
  version: name,
  digest: configurationDigestSchema,
});
const environment = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(64);
const roleFields = {
  runtime: name.nullable(),
  command: name.nullable(),
  timeoutMs: z.number().int().min(1000).max(86_400_000),
  skills: z.array(configurationSkillSchema).max(32),
  environment,
  model: z.string().min(1).max(128).nullable().optional(),
  reasoning: name.nullable().optional(),
  instructions: z.string().min(1).max(4000).optional(),
  workspacePrefix: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/)
    .optional(),
};
export const configurationRoleSchema = z.strictObject(roleFields);
const rolePatch = configurationRoleSchema.partial();
export const configurationPatchSchema = z.strictObject({
  roles: z
    .record(name, rolePatch)
    .refine((value) => Object.keys(value).length <= 32)
    .optional(),
});
export const portableConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: configurationPatchSchema,
});
export const effectiveConfigurationSchema = z.strictObject({
  roles: z.record(name, configurationRoleSchema).refine((value) => Object.keys(value).length <= 32),
});
export const projectAgentSchema = z.strictObject({
  provider: name.describe('Agent provider. The built-in provider is codex.'),
  workspacePrefix: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/)
    .optional()
    .describe('Prefix for this agent’s Herdr workspace label.'),
  permissions: z
    .strictObject({ files: z.enum(['readonly', 'write']).describe('File access for this agent.') })
    .optional(),
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
    .nullable()
    .describe('Provider model name. Set this before starting a job.'),
  reasoning: name
    .nullable()
    .describe(
      'Set before starting a job. Codex supports minimal, low, medium, high, xhigh and max.',
    ),
  hooks: z
    .strictObject({
      before: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => !value.includes('\0'))
        .optional(),
      after: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => !value.includes('\0'))
        .optional(),
    })
    .optional(),
  hookTimeouts: z
    .strictObject({
      before: z.number().int().min(1000).max(86_400_000).optional(),
      after: z.number().int().min(1000).max(86_400_000).optional(),
    })
    .optional(),
  ports: z
    .record(
      managedPortName,
      z.union([
        z.strictObject({ fixed: managedPortNumber }),
        z.strictObject({
          range: z
            .tuple([managedPortNumber, managedPortNumber])
            .refine(([first, last]) => first <= last),
        }),
      ]),
    )
    .refine((value) => Object.keys(value).length <= 32)
    .optional(),
  instructions: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe('Additional instructions for the agent.'),
});
export const hostConfigurationPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    repositoryId: repositoryIdSchema,
    defaultAgents: z
      .strictObject({ implementation: name.optional(), review: name.optional() })
      .optional(),
    user: configurationPatchSchema.default({}),
    project: configurationPatchSchema,
    local: configurationPatchSchema.default({}),
    execution: z.strictObject({
      agentSettings: z.record(name, projectAgentSchema).optional(),
      review: z
        .strictObject({ allowGateOverride: z.boolean(), allowNoChecks: z.boolean().optional() })
        .optional(),
      allowedEnvironment: environment,
      commands: z
        .record(
          name,
          z.strictObject({
            executable: hostPath,
            args: z
              .array(
                z
                  .string()
                  .max(4096)
                  .refine((value) => !value.includes('\0')),
              )
              .max(128),
          }),
        )
        .refine((value) => Object.keys(value).length <= 64),
      skills: z.array(configurationSkillSchema.extend({ path: hostPath })).max(128),
    }),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65_536);
export const projectConfigurationFileSchema = z.strictObject({
  $schema: z.string().min(1).max(1024).optional(),
  schemaVersion: z.literal(1),
  defaultAgents: z
    .strictObject({ implementation: name.optional(), review: name.optional() })
    .optional(),
  agents: z.record(name, projectAgentSchema).refine((value) => Object.keys(value).length <= 32),
  execution: hostConfigurationPolicySchema.shape.execution
    .omit({ agentSettings: true, skills: true })
    .partial()
    .optional(),
});
export const configurationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
  checkoutId: checkoutIdSchema.optional(),
  role: name,
  request: configurationPatchSchema.default({}),
});
export const configurationSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    repositoryId: repositoryIdSchema,
    checkoutId: checkoutIdSchema,
    role: name,
    policyDigest: configurationDigestSchema,
    effectiveDigest: configurationDigestSchema,
    effective: effectiveConfigurationSchema,
    request: configurationPatchSchema,
    provenance: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(256),
          source: z.enum(['defaults', 'user', 'project', 'local', 'request']),
        }),
      )
      .max(512),
    skills: z.array(configurationSkillSchema).max(32),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 16_384);
export const configurationDiagnosticSchema = z.strictObject({
  code: z.enum([
    'policy_missing',
    'agent_model_missing',
    'agent_reasoning_missing',
    'agent_reasoning_unsupported',
    'role_missing',
    'runtime_not_allowed',
    'command_not_allowed',
    'environment_not_allowed',
    'skill_not_approved',
    'executable_missing',
    'environment_missing',
    'skill_unavailable',
    'proposal_changed',
    'policy_changed',
    'snapshot_missing',
    'timeout_not_allowed',
  ]),
  subject: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/)
    .optional(),
  nextStep: z.string().min(1),
});
export const configurationResolutionSchema = z
  .strictObject({
    status: z.enum(['ready', 'blocked']),
    snapshot: configurationSnapshotSchema.nullable(),
    proposal: z.enum(['not_checked', 'absent', 'matches', 'changed']),
    diagnostics: z.array(configurationDiagnosticSchema),
  })
  .refine((value) =>
    value.status === 'blocked'
      ? value.diagnostics.length > 0
      : value.snapshot !== null &&
        value.proposal !== 'not_checked' &&
        value.diagnostics.length === 0,
  );
export const configurationResultSchema = createOperationResultSchema(configurationResolutionSchema);
export type ConfigurationPatch = z.infer<typeof configurationPatchSchema>;
export type ProjectAgent = z.infer<typeof projectAgentSchema>;
export type ProjectConfigurationFile = z.infer<typeof projectConfigurationFileSchema>;
export type EffectiveConfiguration = z.infer<typeof effectiveConfigurationSchema>;
export type HostConfigurationPolicy = z.infer<typeof hostConfigurationPolicySchema>;
export type ConfigurationRequest = z.infer<typeof configurationRequestSchema>;
export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;
export type ConfigurationDiagnostic = z.infer<typeof configurationDiagnosticSchema>;
export type ConfigurationResolution = z.infer<typeof configurationResolutionSchema>;
