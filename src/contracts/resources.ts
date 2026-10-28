import { z } from 'zod';
import { stateIdSchema, createStateWriteResultSchema } from './state.js';
import { createOperationResultSchema } from './operation-result.js';
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = time;
const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const portEndpointSchema = z.strictObject({
  protocol: z.enum(['tcp', 'udp']),
  host: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']),
  port: z.number().int().min(1024).max(65535),
});
export const allocationSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('port'),
    protocol: portEndpointSchema.shape.protocol,
    host: portEndpointSchema.shape.host,
    candidates: z
      .array(portEndpointSchema.shape.port)
      .min(1)
      .max(16)
      .refine((v) => new Set(v).size === v.length),
  }),
  z.strictObject({
    kind: z.literal('name'),
    namespace: z.enum(['service', 'container', 'cache']),
    prefix: name,
    fixed: z.boolean().default(false),
  }),
]);
export const allocationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  attemptId: stateIdSchema,
  key: stateIdSchema,
  spec: allocationSpecSchema,
});
export const allocatedValueSchema = z.discriminatedUnion('kind', [
  portEndpointSchema.extend({ kind: z.literal('port') }),
  z.strictObject({
    kind: z.literal('name'),
    namespace: z.enum(['service', 'container', 'cache']),
    name,
  }),
]);
export const allocationBindingSchema = z.strictObject({
  projectId: stateIdSchema,
  repositoryId: stateIdSchema,
  checkoutId: stateIdSchema,
  branch: z.string().min(1),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export const allocationRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    request: allocationRequestSchema,
    binding: allocationBindingSchema,
    value: allocatedValueSchema,
    phase: z.enum([
      'probing',
      'reserved',
      'blocked',
      'starting',
      'running',
      'retained',
      'released',
    ]),
    revision,
    candidateIndex: z.number().int().min(0).max(15),
    startup: z
      .strictObject({ key: stateIdSchema, controller: stateIdSchema, authorizedRevision: revision })
      .nullable(),
    probe: z.enum(['free', 'busy', 'unknown']).nullable(),
    reason: z.enum(['port_busy', 'probe_unknown']).nullable(),
    endpointVerifiedAt: time.nullable(),
    createdAt: time,
    updatedAt: time,
    release: z
      .strictObject({
        key: stateIdSchema,
        expectedRevision: revision,
        writersStopped: z.literal(true),
        servicesStopped: z.literal(true),
      })
      .nullable(),
  })
  .refine((record) => {
    const spec = record.request.spec;
    const value = record.value;
    const selected =
      spec.kind === 'port' && value.kind === 'port'
        ? spec.protocol === value.protocol &&
          spec.host === value.host &&
          spec.candidates[record.candidateIndex] === value.port
        : spec.kind === 'name' &&
          value.kind === 'name' &&
          record.candidateIndex === 0 &&
          spec.namespace === value.namespace &&
          value.name ===
            (spec.fixed ? spec.prefix : `${spec.prefix.slice(0, 30)}-${record.id.slice(-32)}`);
    const unstarted = ['probing', 'reserved', 'blocked'].includes(record.phase);

    return (
      selected &&
      record.createdAt <= record.updatedAt &&
      (record.release !== null) === (record.phase === 'released') &&
      (unstarted
        ? record.startup === null
        : record.phase === 'released' || record.startup !== null) &&
      (record.startup === null || record.startup.authorizedRevision < record.revision) &&
      (!['running', 'retained'].includes(record.phase) || record.endpointVerifiedAt !== null) &&
      (record.phase !== 'probing' || (value.kind === 'port' && record.probe === null)) &&
      (record.phase !== 'reserved' ||
        (value.kind === 'name' ? record.probe === null : record.probe === 'free'))
    );
  });

export const allocationSelectorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
});
export const allocationRevisionSchema = allocationSelectorSchema.extend({
  expectedRevision: revision,
});
export const allocationStartSchema = allocationRevisionSchema.extend({
  key: stateIdSchema,
  controller: stateIdSchema,
});
export const allocationRunningSchema = allocationStartSchema.extend({
  ownedEndpointVerified: z.literal(true),
});
export const allocationReleaseSchema = allocationRevisionSchema.extend({
  key: stateIdSchema,
  startupKey: stateIdSchema.nullable(),
  writersStopped: z.literal(true),
  servicesStopped: z.literal(true),
});
export const allocationListSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: stateIdSchema.optional(),
  after: z.string().max(128).default(''),
  limit: z.number().int().min(1).max(100).default(50),
});
export const allocationReadResultSchema = createOperationResultSchema(
  allocationRecordSchema.nullable(),
);
export const allocationWriteResultSchema = createStateWriteResultSchema(allocationRecordSchema);
export type AllocationSpec = z.infer<typeof allocationSpecSchema>;
export type AllocationRequest = z.infer<typeof allocationRequestSchema>;
export type AllocationRecord = z.infer<typeof allocationRecordSchema>;
export type AllocatedValue = z.infer<typeof allocatedValueSchema>;
export type PortEndpoint = z.infer<typeof portEndpointSchema>;
export type AllocationStart = z.infer<typeof allocationStartSchema>;
export type AllocationRelease = z.infer<typeof allocationReleaseSchema>;

export type AllocationRunning = z.infer<typeof allocationRunningSchema>;
