import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { configurationRequestSchema } from './configuration.js';
import {
  instructionPathSchema,
  instructionReferenceSchema,
  issueReferenceSchema,
} from './task-context.js';
import { worktreePrepareRequestSchema } from './worktrees.js';
import { stateIdSchema } from './state.js';
import { workerInputTextSchema } from './worker-input.js';

/** Project-specific agent names carry no workflow semantics in Astack. */
export const genericHandoffSubmissionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: configurationRequestSchema.shape.projectId,
  agent: configurationRequestSchema.shape.role,
  context: issueReferenceSchema.extend({ kind: z.enum(['issue', 'pr']) }).optional(),
  key: stateIdSchema,
  task: workerInputTextSchema.refine((value) => Buffer.byteLength(value) <= 6000),
  baseCommit: z
    .union([worktreePrepareRequestSchema.shape.baseCommit, z.literal('pr-head')])
    .optional(),
  instructionPaths: z
    .array(instructionPathSchema)
    .max(8)
    .default(['AGENTS.md', 'AGENTS.override.md']),
  request: configurationRequestSchema.shape.request,
});

export const genericHandoffTaskSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    workflow: z.literal('handoff'),
    submission: genericHandoffSubmissionSchema.extend({
      checkoutId: configurationRequestSchema.shape.checkoutId.unwrap(),
      branch: worktreePrepareRequestSchema.shape.branch,
      commit: worktreePrepareRequestSchema.shape.baseCommit,
    }),
    worktreeId: stateIdSchema,
    root: z.string().min(1).max(4096),
    instructions: z.array(instructionReferenceSchema).max(8),
    contextPath: z.string().min(1).max(4096).refine(isAbsolute).optional(),
    stateDirectory: z.string().min(1).max(4096).refine(isAbsolute),
  })
  .refine(
    (value) =>
      value.instructions.length === value.submission.instructionPaths.length &&
      value.instructions.every(
        (instruction, index) => instruction.path === value.submission.instructionPaths[index],
      ) &&
      Boolean(value.contextPath) === Boolean(value.submission.context),
  );

export const genericHandoffReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: stateIdSchema,
  attemptId: stateIdSchema,
  projectId: configurationRequestSchema.shape.projectId,
  checkoutId: configurationRequestSchema.shape.checkoutId.unwrap(),
  outcome: z.enum(['completed', 'needs_decision', 'failed']),
  summary: workerInputTextSchema.refine((value) => Buffer.byteLength(value) <= 4000),
  blockers: z
    .array(workerInputTextSchema.refine((value) => Buffer.byteLength(value) <= 512))
    .max(16),
});

export type GenericHandoffTask = z.infer<typeof genericHandoffTaskSchema>;
