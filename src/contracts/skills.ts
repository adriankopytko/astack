import { z } from 'zod';
import {
  absoluteFilePathSchema,
  managedFileRecordSchema,
  managedFileInspectionSchema,
  managedFileResultSchema,
} from './managed-files.js';
import { createOperationResultSchema, rejectedResultSchema } from './operation-result.js';
export const skillIdSchema = z.enum(['orchestrator', 'implementer', 'reviewer']);
const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .max(64);
export const skillAssetSchema = z
  .strictObject({
    id: skillIdSchema,
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(512),
    version,
    path: z.string().min(1).max(128),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .refine(
    (asset) => asset.name === `astack-${asset.id}` && asset.path === `${asset.name}/SKILL.md`,
  );
export const skillCatalogSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    namespace: z.literal('astack'),
    version,
    skills: z.array(skillAssetSchema).length(3),
  })
  .refine((catalog) => new Set(catalog.skills.map((asset) => asset.id)).size === 3);
export const skillBundleSchema = z
  .strictObject({
    catalog: skillCatalogSchema,
    contents: z
      .array(
        z.strictObject({
          id: skillIdSchema,
          content: z.string().refine((content) => Buffer.byteLength(content) <= 65536),
        }),
      )
      .length(3),
  })
  .refine((bundle) => new Set(bundle.contents.map((asset) => asset.id)).size === 3);
export const skillsReadSchema = z.strictObject({ schemaVersion: z.literal(1) });
export const skillShowSchema = skillsReadSchema.extend({ id: skillIdSchema });
export const skillsInspectSchema = skillsReadSchema
  .extend({
    root: absoluteFilePathSchema,
    mode: z.union([z.literal(0o600), z.literal(0o644)]).default(0o600),
    skills: z
      .array(skillIdSchema)
      .min(1)
      .max(3)
      .default(['orchestrator', 'implementer', 'reviewer']),
  })
  .refine((request) => new Set(request.skills).size === request.skills.length);
export const skillInstallationSchema = z.strictObject({
  asset: skillAssetSchema,
  state: z.enum(['missing', 'current', 'outdated', 'conflict', 'pending']),
  reason: z.string().min(1).max(128).nullable(),
  record: managedFileRecordSchema.nullable(),
  inspection: managedFileInspectionSchema.nullable(),
});
export const skillsInstallationViewSchema = z.strictObject({
  root: absoluteFilePathSchema,
  rootExists: z.boolean(),
  catalogVersion: version,
  available: z.boolean(),
  skills: z.array(skillInstallationSchema).min(1).max(3),
});
export const skillsInstallResultSchema = z.union([
  rejectedResultSchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.enum(['installed', 'unchanged', 'blocked', 'pending']),
    view: skillsInstallationViewSchema,
    writes: z
      .array(z.strictObject({ id: skillIdSchema, result: managedFileResultSchema.nullable() }))
      .max(3),
  }),
]);
export const skillCatalogResultSchema = createOperationResultSchema(skillCatalogSchema);
export const skillShowResultSchema = createOperationResultSchema(
  z.strictObject({ asset: skillAssetSchema, content: z.string() }),
);
export const skillsInspectResultSchema = createOperationResultSchema(skillsInstallationViewSchema);
export type SkillId = z.infer<typeof skillIdSchema>;
export type SkillAsset = z.infer<typeof skillAssetSchema>;
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;
export type SkillBundle = z.infer<typeof skillBundleSchema>;
export type SkillInstallation = z.infer<typeof skillInstallationSchema>;
export type SkillsInstallationView = z.infer<typeof skillsInstallationViewSchema>;
export type SkillsInstallResult = z.infer<typeof skillsInstallResultSchema>;
