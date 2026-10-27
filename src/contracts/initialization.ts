import { z } from 'zod';
import {
  projectSelectionRequestSchema,
  checkoutLocationSchema,
  projectRegistrationResultSchema,
} from './projects.js';
import {
  absoluteFilePathSchema,
  relativeFilePathSchema,
  managedFileInspectionSchema,
  managedFileResultSchema,
} from './managed-files.js';
import { skillIdSchema, skillsInspectResultSchema, skillsInstallResultSchema } from './skills.js';
import { herdrTargetSchema, herdrSettingsSchema, herdrResultSchema } from './herdr.js';
import { configurationResultSchema } from './configuration.js';
import { rejectedResultSchema } from './operation-result.js';
export const initializationRequestSchema = projectSelectionRequestSchema
  .safeExtend({
    preview: z.boolean().default(false),
    assignProjectId: projectSelectionRequestSchema.shape.projectId,
    skills: z.array(skillIdSchema).max(3).default([]),
    herdr: z
      .strictObject({
        target: herdrTargetSchema.optional(),
        label: herdrSettingsSchema.shape.label.optional(),
      })
      .optional(),
  })
  .refine((value) => new Set(value.skills).size === value.skills.length);
export const initializationSignalsSchema = z.strictObject({
  stacks: z.array(z.enum(['node', 'rust', 'python', 'go'])).max(4),
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun']).nullable(),
  scripts: z.array(z.enum(['test', 'lint', 'typecheck', 'build', 'dev'])).max(5),
  suggestions: z
    .array(
      z.strictObject({
        hook: z.enum(['verify', 'setup']),
        manager: z.enum(['pnpm', 'npm', 'yarn', 'bun']),
        script: z.enum(['test', 'lint', 'typecheck', 'build', 'dev']),
      }),
    )
    .max(5),
  diagnostics: z.array(z.string().min(1).max(128)).max(16),
});
export const initializationAssetSchema = z.strictObject({
  kind: z.enum(['proposal', 'host-policy', 'project-ignore', 'skills-ignore']),
  root: absoluteFilePathSchema,
  path: relativeFilePathSchema,
  state: z.enum([
    'planned',
    'missing',
    'current',
    'preserved',
    'blocked',
    'pending',
    'written',
    'unchanged',
  ]),
  reason: z.string().max(128).nullable(),
  inspection: managedFileInspectionSchema.nullable(),
  write: managedFileResultSchema.nullable(),
});
export const initializationViewSchema = z.strictObject({
  target: z.strictObject({
    root: absoluteFilePathSchema,
    location: checkoutLocationSchema,
    branch: z.string().nullable(),
    commit: z.string().nullable(),
    linked: z.boolean(),
    projectId: z.string().nullable(),
    repositoryId: z.string().nullable(),
    checkoutId: z.string().nullable(),
  }),
  registration: z.enum(['required', 'registered', 'created', 'uncertain']),
  signals: initializationSignalsSchema,
  assets: z.array(initializationAssetSchema).max(4),
  userSkills: skillsInspectResultSchema,
  projectSkills: z.union([skillsInspectResultSchema, skillsInstallResultSchema]).nullable(),
  provider: z.strictObject({
    status: z.enum(['not_selected', 'planned', 'ready', 'blocked', 'pending']),
    settings: herdrSettingsSchema.nullable(),
    result: herdrResultSchema.nullable(),
  }),
  configuration: z
    .array(
      z.strictObject({
        role: z.enum(['implementer', 'reviewer']),
        result: configurationResultSchema,
      }),
    )
    .max(2),
  delegation: z.enum(['not_ready', 'requires_owned_checkout']),
  diagnostics: z
    .array(
      z.strictObject({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) }),
    )
    .max(64),
});
export const initializationResultSchema = z.union([
  rejectedResultSchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.enum(['previewed', 'initialized', 'partial']),
    view: initializationViewSchema,
    registration: projectRegistrationResultSchema.nullable(),
  }),
]);
export type InitializationRequest = z.infer<typeof initializationRequestSchema>;
export type InitializationSignals = z.infer<typeof initializationSignalsSchema>;
export type InitializationAsset = z.infer<typeof initializationAssetSchema>;
export type InitializationView = z.infer<typeof initializationViewSchema>;
export type InitializationResult = z.infer<typeof initializationResultSchema>;
