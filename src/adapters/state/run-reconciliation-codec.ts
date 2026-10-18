import { z } from 'zod';
import {
  runReconciliationSchema,
  runReconcileRequestSchema,
} from '../../contracts/run-reconciliation.js';
import { runtimeSessionSchema } from '../../contracts/runtime.js';
import { stateIdSchema } from '../../contracts/state.js';

// Preserve the first pilot journal representation without rewriting historical host attestations.
const legacy = z
  .strictObject({
    request: runReconcileRequestSchema,
    source: z.literal('host-attestation'),
    session: runtimeSessionSchema,
    verifiedAt: z.number().int().nonnegative(),
    providerEvidence: z.literal('owned-workspace-and-agent-absent'),
    releasedResourceIds: z.array(stateIdSchema).max(4),
  })
  .transform((record) => {
    const session = record.session;
    const workerHandle = {
      runtime: session.runtime,
      launchId: session.launchId,
      spaceId: session.space.id,
    };
    const layout = {
      target: session.space.target,
      server: session.space.server,
      layout: session.space.handle,
    };

    return runReconciliationSchema.parse({
      request: record.request,
      source: record.source,
      workerHandle,
      resourceBindings: [
        {
          id: `worker:${record.request.attemptId}`,
          kind: 'worker',
          key: record.request.attemptId,
          handle: workerHandle,
        },
        {
          id: `runtime:${session.launchId}`,
          kind: 'interactive-runtime',
          key: session.launchId,
          handle: workerHandle,
        },
        {
          id: `herdr:${session.space.id}`,
          kind: 'herdr-space',
          key: session.space.id,
          handle: layout,
        },
        {
          id: `agent:${session.space.id}`,
          kind: 'herdr-agent',
          key: session.space.id,
          handle: { ...layout, agent: session.agent },
        },
      ],
      verifiedAt: record.verifiedAt,
      providerEvidence: {
        runtime: session.runtime,
        reason: record.providerEvidence,
        server: session.space.server,
      },
      releasedResourceIds: record.releasedResourceIds,
    });
  });

export const persistedRunReconciliationSchema = z.union([runReconciliationSchema, legacy]);
