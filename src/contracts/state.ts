import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { configurationSnapshotSchema, configurationRequestSchema } from './configuration.js';
import {
  checkoutRecordSchema,
  projectRecordSchema,
  repositoryIdSchema,
} from './project-context.js';
import {
  createOperationResultSchema,
  rejectedResultSchema,
  type RejectedResult,
} from './operation-result.js';

export const stateIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function smallMetadata(value: unknown): boolean {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    nodes++;

    if (nodes > 1024 || depth > 16) {
      return false;
    }

    if (item === null || typeof item === 'boolean') {
      return true;
    }

    if (typeof item === 'number') {
      return Number.isFinite(item);
    }

    if (typeof item === 'string') {
      return item.length <= 16_384;
    }

    if (typeof item !== 'object' || seen.has(item)) {
      return false;
    }

    seen.add(item);
    const prototype: unknown = Object.getPrototypeOf(item);

    if (!Array.isArray(item) && prototype !== null && prototype !== Object.prototype) {
      return false;
    }

    const entries = Object.entries(item);

    return (
      entries.length <= 1024 &&
      entries.every(([key, child]) => key.length <= 1024 && visit(child, depth + 1))
    );
  };

  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      visit(value, 0) &&
      Buffer.byteLength(JSON.stringify(value)) <= 16_384
    );
  } catch {
    return false;
  }
}

const metadata = z.unknown().refine(smallMetadata).pipe(z.record(z.string(), z.json()));
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const stateOpenRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.enum(['read-write', 'read-only']).default('read-write'),
  stateDirectory: absolutePath.optional(),
  busyTimeoutMs: z.number().int().min(0).max(1000).default(100),
});
export const stateRepositorySchema = z.strictObject({
  id: repositoryIdSchema,
  commonDirectory: absolutePath,
  objectFormat: z.enum(['sha1', 'sha256']),
});
export const stateProjectRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    repository: stateRepositorySchema,
    project: projectRecordSchema,
    checkout: checkoutRecordSchema,
  })
  .superRefine((value, context) => {
    if (
      value.checkout.projectId !== value.project.id ||
      value.checkout.id !== value.project.primaryCheckoutId ||
      value.checkout.repositoryId !== value.repository.id ||
      value.checkout.gitCommonDirectory !== value.repository.commonDirectory
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Project, checkout and repository identities must agree',
      });
    }
  });
export const stateJobSchema = z
  .strictObject({
    id: stateIdSchema,
    projectId: checkoutRecordSchema.shape.projectId,
    repositoryId: repositoryIdSchema,
    checkoutId: checkoutRecordSchema.shape.id,
    requester: stateIdSchema,
    operation: stateIdSchema,
    idempotencyKey: stateIdSchema,
    createdAt: timestamp,
    intent: metadata,
    configuration: configurationSnapshotSchema.optional(),
  })
  .refine(
    (value) =>
      value.configuration === undefined ||
      (value.configuration.projectId === value.projectId &&
        value.configuration.repositoryId === value.repositoryId &&
        value.configuration.checkoutId === value.checkoutId),
  )
  .refine((value) => {
    try {
      return JSON.stringify(value).length <= 32_768;
    } catch {
      return false;
    }
  });
export const stateJobRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  job: stateJobSchema,
});
export const configuredJobRequestSchema = stateJobRequestSchema.extend({
  role: configurationRequestSchema.shape.role,
  request: configurationRequestSchema.shape.request,
});
export const stateAttemptSchema = z.strictObject({
  id: stateIdSchema,
  jobId: stateIdSchema,
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  branch: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.startsWith('refs/') && !value.includes('\0'))
    .nullable(),
  commit,
  createdAt: timestamp,
});
export const stateEffectIntentSchema = z.strictObject({
  id: stateIdSchema,
  attemptId: stateIdSchema,
  kind: stateIdSchema,
  key: stateIdSchema,
  createdAt: timestamp,
  payload: metadata,
});
export const stateClaimSchema = z
  .strictObject({
    owner: stateIdSchema,
    token: stateIdSchema,
    claimedAt: timestamp,
    expiresAt: timestamp,
  })
  .refine(
    (value) => value.expiresAt > value.claimedAt && value.expiresAt - value.claimedAt <= 30_000,
  );
export const stateEffectSchema = z
  .strictObject({
    intent: stateEffectIntentSchema,
    state: z.enum(['pending', 'confirmed', 'unknown', 'cancelled']),
    claim: stateClaimSchema.nullable(),
    evidence: metadata.nullable(),
  })
  .superRefine((value, context) => {
    if (
      (value.state !== 'pending' && (value.claim === null || value.evidence === null)) ||
      (value.state === 'pending' && value.evidence !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Resolved effects require a claim and evidence',
      });
    }
  });
export const stateAttemptRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    attempt: stateAttemptSchema,
    effects: z.array(stateEffectIntentSchema).min(1).max(16),
  })
  .superRefine((value, context) => {
    if (
      value.effects.some((effect) => effect.attemptId !== value.attempt.id) ||
      new Set(value.effects.map((effect) => effect.id)).size !== value.effects.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Effects must belong to the attempt and have distinct IDs',
      });
    }
  });
export const stateClaimRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  effectId: stateIdSchema,
  owner: stateIdSchema,
  token: stateIdSchema,
  leaseMs: z.number().int().min(1).max(30_000).default(10_000),
});
export const stateEffectResolutionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  effectId: stateIdSchema,
  owner: stateIdSchema,
  token: stateIdSchema,
  state: z.enum(['confirmed', 'unknown', 'cancelled']),
  evidence: metadata,
});
export const stateResultSchema = z.strictObject({
  id: stateIdSchema,
  attemptId: stateIdSchema,
  outcome: z.enum(['completed', 'failed', 'cancelled']),
  createdAt: timestamp,
  evidence: metadata,
});
export const stateResultRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  result: stateResultSchema,
});
export const stateResourceIntentSchema = z.strictObject({
  id: stateIdSchema,
  attemptId: stateIdSchema,
  kind: stateIdSchema,
  key: stateIdSchema,
  createdAt: timestamp,
  handle: metadata,
});
export const stateResourceSchema = z
  .strictObject({
    intent: stateResourceIntentSchema,
    releasedAt: timestamp.nullable(),
    releaseEvidence: metadata.nullable(),
  })
  .refine((value) => (value.releasedAt === null) === (value.releaseEvidence === null));
export const stateResourceRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resource: stateResourceIntentSchema,
});
export const stateResourceReleaseRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resourceId: stateIdSchema,
  attemptId: stateIdSchema,
  evidence: metadata,
});
export const stateInspectionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entity: z.enum(['job', 'attempt', 'effect', 'result', 'resource']),
  id: stateIdSchema,
});
export const stateRecordSchema = z.discriminatedUnion('entity', [
  z.strictObject({ entity: z.literal('job'), record: stateJobSchema }),
  z.strictObject({
    entity: z.literal('attempt'),
    record: stateAttemptSchema,
    resolvedAt: timestamp.nullable(),
  }),
  z.strictObject({ entity: z.literal('effect'), record: stateEffectSchema }),
  z.strictObject({ entity: z.literal('result'), record: stateResultSchema }),
  z.strictObject({ entity: z.literal('resource'), record: stateResourceSchema }),
]);
export const stateInspectionResultSchema = createOperationResultSchema(
  stateRecordSchema.nullable(),
);

export const stateUncertainResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  outcome: z.literal('uncertain'),
  error: z.strictObject({ code: z.literal('state_write_uncertain'), message: z.string().min(1) }),
});
export function createStateWriteResultSchema<T extends z.ZodType>(value: T) {
  return z.union([
    z.strictObject({
      schemaVersion: z.literal(1),
      outcome: z.literal('persisted'),
      disposition: z.enum(['created', 'existing', 'updated']),
      value,
    }),
    stateUncertainResultSchema,
    rejectedResultSchema,
  ]);
}

export type StateWriteResult<T> =
  | {
      schemaVersion: 1;
      outcome: 'persisted';
      disposition: 'created' | 'existing' | 'updated';
      value: T;
    }
  | {
      schemaVersion: 1;
      outcome: 'uncertain';
      error: { code: 'state_write_uncertain'; message: string };
    }
  | RejectedResult;
export type StateOpenRequest = z.infer<typeof stateOpenRequestSchema>;
export type StateRepository = z.infer<typeof stateRepositorySchema>;
export type StateClaim = z.infer<typeof stateClaimSchema>;
export type StateProjectRequest = z.infer<typeof stateProjectRequestSchema>;
export type StateJob = z.infer<typeof stateJobSchema>;
export type StateJobRequest = z.infer<typeof stateJobRequestSchema>;
export type ConfiguredJobRequest = z.infer<typeof configuredJobRequestSchema>;
export type StateAttempt = z.infer<typeof stateAttemptSchema>;
export type StateAttemptRequest = z.infer<typeof stateAttemptRequestSchema>;
export type StateEffectIntent = z.infer<typeof stateEffectIntentSchema>;
export type StateEffect = z.infer<typeof stateEffectSchema>;
export type StateClaimRequest = z.infer<typeof stateClaimRequestSchema>;
export type StateEffectResolutionRequest = z.infer<typeof stateEffectResolutionRequestSchema>;
export type StateResult = z.infer<typeof stateResultSchema>;
export type StateResultRequest = z.infer<typeof stateResultRequestSchema>;
export type StateResourceIntent = z.infer<typeof stateResourceIntentSchema>;
export type StateResource = z.infer<typeof stateResourceSchema>;
export type StateResourceRequest = z.infer<typeof stateResourceRequestSchema>;
export type StateResourceReleaseRequest = z.infer<typeof stateResourceReleaseRequestSchema>;
export type StateInspectionRequest = z.infer<typeof stateInspectionRequestSchema>;
export type StateRecord = z.infer<typeof stateRecordSchema>;
