import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { rejectedResultSchema } from './operation-result.js';

export const managedMetadataDirectory = '.astack-managed';
export const maximumManagedFileBytes = 1024 * 1024;
export const absoluteFilePathSchema = z
  .string()
  .refine((value) => isAbsolute(value) && !value.includes('\0'));
export const relativeFilePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes('\0') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  );
const managedTarget = relativeFilePathSchema.refine(
  (value) =>
    value.split('/')[0] !== managedMetadataDirectory &&
    !value.split('/').some((part) => part.startsWith('.astack-stage-')),
);
const owner = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const fileMode = z.union([z.literal(0o600), z.literal(0o644), z.literal(0o700), z.literal(0o755)]);

export const managedFileRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  path: managedTarget,
  owner,
  assetVersion: z.string().min(1).max(128),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: fileMode,
});
export const managedFileRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  root: absoluteFilePathSchema,
  path: managedTarget,
  owner,
  assetVersion: z.string().min(1).max(128),
  mode: fileMode.default(0o600),
  content: z.string().refine((value) => Buffer.byteLength(value) <= maximumManagedFileBytes),
});
export const inspectManagedFileRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  root: absoluteFilePathSchema,
  path: managedTarget,
});
export const managedWriteIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: z.uuid(),
  before: managedFileRecordSchema.nullable(),
  after: managedFileRecordSchema,
  stagePath: relativeFilePathSchema,
});
export const fileProblemSchema = z.enum([
  'unsafe_path',
  'missing_parent',
  'unowned_file',
  'modified_file',
  'owner_mismatch',
  'metadata_invalid',
  'busy',
  'cancelled',
  'io_failed',
  'target_changed',
  'metadata_changed',
]);
const blockedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  outcome: z.literal('blocked'),
  reason: fileProblemSchema,
});
export const managedFileResultSchema = z.union([
  rejectedResultSchema,
  blockedSchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.enum(['written', 'unchanged']),
    root: absoluteFilePathSchema,
    record: managedFileRecordSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('pending'),
    root: absoluteFilePathSchema,
    reason: fileProblemSchema,
    intent: managedWriteIntentSchema,
  }),
]);
export const managedFileInspectionSchema = z.union([
  rejectedResultSchema,
  blockedSchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('inspected'),
    root: absoluteFilePathSchema,
    state: z.enum(['missing', 'unowned', 'managed', 'modified', 'pending']),
    observation: z.enum([
      'missing',
      'unowned',
      'matches-record',
      'matches-intent',
      'modified',
      'unverified',
    ]),
    record: managedFileRecordSchema.nullable(),
    pending: managedWriteIntentSchema.nullable(),
  }),
]);

export type ManagedFileRecord = z.infer<typeof managedFileRecordSchema>;
export type ManagedFileRequest = z.infer<typeof managedFileRequestSchema>;
export type InspectManagedFileRequest = z.infer<typeof inspectManagedFileRequestSchema>;
export type ManagedWriteIntent = z.infer<typeof managedWriteIntentSchema>;
export type ManagedFileResult = z.infer<typeof managedFileResultSchema>;
export type ManagedFileInspection = z.infer<typeof managedFileInspectionSchema>;
export type FileProblem = z.infer<typeof fileProblemSchema>;
