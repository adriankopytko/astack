import { z } from 'zod';
import {
  checkoutRecordSchema,
  projectIdSchema,
  repositoryIdSchema,
  checkoutIdSchema,
} from './project-context.js';
import { checkoutLocationSchema } from './projects.js';
import { stateIdSchema, stateAttemptSchema } from './state.js';
import { rejectedResultSchema } from './operation-result.js';

const path = checkoutRecordSchema.shape.rootPath;
function noControls(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);

    if (code < 32 || code === 127) {
      return false;
    }
  }

  return true;
}

const token = z.string().min(1).max(256).refine(noControls);
const agentName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const herdrTargetSchema = z.strictObject({
  session: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
    .default('default'),
  socketPath: path,
});
export const herdrServerSchema = herdrTargetSchema.extend({
  device: z.string().regex(/^[0-9]+$/),
  inode: z.string().regex(/^[0-9]+$/),
  changedAtNs: z.string().regex(/^[0-9]+$/),
  protocol: z.literal(22),
});
export const herdrHandleSchema = z.strictObject({
  workspaceId: token,
  tabId: token,
  paneId: token,
  terminalId: token,
});
export const herdrAgentSchema = z.strictObject({
  name: agentName,
  kind: token,
  nativeSessionId: token.nullable(),
});
export const herdrSettingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
  repositoryId: repositoryIdSchema,
  primaryCheckoutId: checkoutIdSchema,
  root: path,
  location: checkoutLocationSchema,
  target: herdrTargetSchema,
  label: z.string().min(1).max(80).refine(noControls),
});
export const herdrSpaceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: stateIdSchema,
    projectId: projectIdSchema,
    repositoryId: repositoryIdSchema,
    checkoutId: checkoutIdSchema,
    root: path,
    location: checkoutLocationSchema,
    kind: z.enum(['primary', 'worker']),
    attemptId: stateIdSchema.nullable(),
    branch: stateAttemptSchema.shape.branch,
    commit: stateAttemptSchema.shape.commit.nullable(),
    target: herdrTargetSchema,
    server: herdrServerSchema,
    phase: z.enum(['pending', 'ready']),
    operationId: stateIdSchema,
    revision: z.number().int().nonnegative(),
    label: herdrSettingsSchema.shape.label,
    primaryWorkspaceId: token.nullable(),
    primaryRoot: path.nullable(),
    expectedAgentName: agentName.nullable(),
    handle: herdrHandleSchema.nullable(),
    agent: herdrAgentSchema.nullable(),
  })
  .refine(
    (value) =>
      value.target.socketPath === value.server.socketPath &&
      value.target.session === value.server.session &&
      value.location.root.path === value.root &&
      (value.phase !== 'ready' || value.handle !== null) &&
      (value.kind === 'primary'
        ? value.attemptId === null &&
          value.primaryWorkspaceId === null &&
          value.primaryRoot === null &&
          value.agent === null &&
          value.expectedAgentName === null
        : value.attemptId !== null &&
          value.primaryWorkspaceId !== null &&
          value.primaryRoot !== null &&
          value.commit !== null &&
          value.branch !== null &&
          value.expectedAgentName !== null),
  );

export const herdrConfigureRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
  target: herdrTargetSchema,
  label: herdrSettingsSchema.shape.label.optional(),
});
export const herdrProjectRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
});
export const herdrWorkerRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attemptId: stateIdSchema,
});
export const herdrAgentRequestSchema = herdrWorkerRequestSchema.extend({ kind: token });
export const herdrReconcileRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stateIdSchema,
  operationId: stateIdSchema,
  writerStopped: z.literal(true),
});
export const herdrReasonSchema = z.enum([
  'layout_missing',
  'layout_changed',
  'server_changed',
  'ambiguous',
  'unowned_workspace',
  'pending_writer',
  'provider_uncertain',
  'assignment_changed',
  'managed_checkout_required',
  'agent_mismatch',
]);
export const herdrObservationSchema = z.strictObject({
  server: herdrServerSchema,
  handle: herdrHandleSchema.nullable(),
  agent: herdrAgentSchema.nullable(),
  agentStatus: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']).nullable(),
});
export const herdrResultSchema = z.union([
  rejectedResultSchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('uncertain'),
    error: z.strictObject({ code: z.literal('state_write_uncertain'), message: z.string() }),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.enum(['prepared', 'reused', 'inspected', 'reconciled', 'blocked', 'pending']),
    record: herdrSpaceSchema.nullable(),
    reason: herdrReasonSchema.nullable(),
    observation: herdrObservationSchema.nullable(),
  }),
]);
export const herdrSnapshotSchema = z.strictObject({
  server: herdrServerSchema,
  workspaces: z.array(
    z.strictObject({
      id: token,
      label: z.string(),
      worktree: z
        .strictObject({
          checkoutPath: path,
          repositoryRoot: path,
          repositoryKey: token,
          linked: z.boolean(),
        })
        .nullable(),
    }),
  ),
  tabs: z.array(z.strictObject({ id: token, workspaceId: token })),
  panes: z.array(
    herdrHandleSchema.extend({ cwd: path.nullable(), foregroundCwd: path.nullable() }),
  ),
  agents: z.array(
    herdrHandleSchema.extend({
      name: agentName.nullable(),
      kind: token.nullable(),
      nativeSessionId: token.nullable(),
      cwd: path.nullable(),
      foregroundCwd: path.nullable(),
      status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']),
    }),
  ),
});
export type HerdrTarget = z.infer<typeof herdrTargetSchema>;
export type HerdrServer = z.infer<typeof herdrServerSchema>;
export type HerdrHandle = z.infer<typeof herdrHandleSchema>;
export type HerdrAgent = z.infer<typeof herdrAgentSchema>;
export type HerdrSettings = z.infer<typeof herdrSettingsSchema>;
export type HerdrSpace = z.infer<typeof herdrSpaceSchema>;
export type HerdrSnapshot = z.infer<typeof herdrSnapshotSchema>;
export type HerdrResult = z.infer<typeof herdrResultSchema>;
export type HerdrReason = z.infer<typeof herdrReasonSchema>;
