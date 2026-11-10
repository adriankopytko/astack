import {
  worktreePrepareRequestSchema,
  worktreeReconcileRequestSchema,
  worktreeResultSchema,
} from './worktrees.js';
import { initializationRequestSchema, initializationResultSchema } from './initialization.js';
import { absoluteFilePathSchema } from './managed-files.js';
import {
  cleanupRequestSchema,
  cleanupControlSchema,
  cleanupReadSchema,
  cleanupReadResultSchema,
  cleanupWriteResultSchema,
} from './cleanup.js';
import {
  reviewAutomationReadSchema,
  reviewAutomationSetSchema,
  followUpEnqueueSchema,
  followUpReadSchema,
  followUpControlSchema,
  followUpListRequestSchema,
  reviewAutomationReadResultSchema,
  reviewAutomationWriteResultSchema,
  followUpReadResultSchema,
  followUpWriteResultSchema,
  followUpListResultSchema,
} from './automatic-review.js';
import {
  ciWatchRequestSchema,
  ciControlRequestSchema,
  ciReadRequestSchema,
  ciListRequestSchema,
  ciTickRequestSchema,
  ciReadResultSchema,
  ciWriteResultSchema,
  ciListResultSchema,
  ciWakeResultSchema,
} from './ci.js';
import {
  runReadRequestSchema,
  runReportRequestSchema,
  runResponseRequestSchema,
  runResumeRequestSchema,
  runCancelRequestSchema,
  runEventsRequestSchema,
  runCursorReadRequestSchema,
  runCursorRequestSchema,
  runReadResultSchema,
  runWriteResultSchema,
  runEventsResultSchema,
  runCursorResultSchema,
  runCursorWriteResultSchema,
} from './runs.js';
import { z } from 'zod';
import {
  serviceSubmitRequestSchema,
  serviceReadRequestSchema,
  serviceStatusSchema,
  serviceJobSchema,
} from './service.js';
import {
  implementationReadResultSchema,
  implementationSubmitResultSchema,
} from './implementation.js';
import { reviewReadResultSchema, reviewSubmitResultSchema } from './review.js';
import { createOperationResultSchema } from './operation-result.js';
import { createStateWriteResultSchema } from './state.js';
import { workerQueueReadResultSchema, workerQueueWriteResultSchema } from './worker-queue.js';
import { genericHandoffSubmissionSchema } from './generic-handoff.js';

export const serviceRpcRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal('project_initialize'),
    request: initializationRequestSchema,
    userSkillsRoot: absoluteFilePathSchema,
    gitExecutable: absoluteFilePathSchema,
    herdrExecutable: absoluteFilePathSchema.nullable(),
  }),
  worktreePrepareRequestSchema.extend({ operation: z.literal('worker_worktree_prepare') }),
  worktreeReconcileRequestSchema.extend({ operation: z.literal('worker_worktree_reconcile') }),
  genericHandoffSubmissionSchema.extend({ operation: z.literal('handoff_submit') }),
  cleanupRequestSchema.extend({ operation: z.literal('cleanup_request') }),
  cleanupControlSchema.extend({ operation: z.literal('cleanup_control') }),
  cleanupReadSchema.extend({ operation: z.literal('cleanup_inspect') }),
  reviewAutomationReadSchema.extend({ operation: z.literal('review_automation_inspect') }),
  reviewAutomationSetSchema.extend({ operation: z.literal('review_automation_configure') }),
  followUpEnqueueSchema.extend({ operation: z.literal('follow_up_enqueue') }),
  followUpReadSchema.extend({ operation: z.literal('follow_up_inspect') }),
  followUpControlSchema.extend({ operation: z.literal('follow_up_control') }),
  followUpListRequestSchema.extend({ operation: z.literal('follow_up_list') }),
  ciWatchRequestSchema.extend({ operation: z.literal('ci_watch') }),
  ciControlRequestSchema.safeExtend({ operation: z.literal('ci_control') }),
  ciReadRequestSchema.extend({ operation: z.literal('ci_inspect') }),
  ciListRequestSchema.extend({ operation: z.literal('ci_list') }),
  ciTickRequestSchema.extend({ operation: z.literal('ci_wake') }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('status') }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('stop') }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('wake') }),
  serviceSubmitRequestSchema.extend({ operation: z.literal('submit') }),
  serviceReadRequestSchema.extend({ operation: z.literal('inspect') }),
  runReadRequestSchema.extend({ operation: z.literal('run_inspect') }),
  runReportRequestSchema.extend({ operation: z.literal('run_report') }),
  runResponseRequestSchema.extend({ operation: z.literal('run_respond') }),
  runResumeRequestSchema.extend({ operation: z.literal('run_resume') }),
  runCancelRequestSchema.extend({ operation: z.literal('run_cancel') }),
  runEventsRequestSchema.extend({ operation: z.literal('run_events') }),
  runCursorReadRequestSchema.extend({ operation: z.literal('run_cursor') }),
  runCursorRequestSchema.extend({ operation: z.literal('run_checkpoint') }),
]);
export const serviceRpcResponseSchema = z.union([
  workerQueueReadResultSchema,
  workerQueueWriteResultSchema,
  createOperationResultSchema(z.strictObject({ workerWorktree: worktreeResultSchema })),
  createOperationResultSchema(initializationResultSchema),
  cleanupReadResultSchema,
  cleanupWriteResultSchema,
  reviewAutomationReadResultSchema,
  reviewAutomationWriteResultSchema,
  followUpReadResultSchema,
  followUpWriteResultSchema,
  followUpListResultSchema,
  ciReadResultSchema,
  ciWriteResultSchema,
  ciListResultSchema,
  ciWakeResultSchema,
  createOperationResultSchema(serviceStatusSchema),
  createOperationResultSchema(z.strictObject({ stopping: z.literal(true) })),
  createOperationResultSchema(serviceJobSchema.nullable()),
  createStateWriteResultSchema(serviceJobSchema),
  implementationReadResultSchema,
  implementationSubmitResultSchema,
  reviewReadResultSchema,
  reviewSubmitResultSchema,
  runReadResultSchema,
  runWriteResultSchema,
  runEventsResultSchema,
  runCursorResultSchema,
  runCursorWriteResultSchema,
]);
export type ServiceRpcRequest = z.infer<typeof serviceRpcRequestSchema>;
export type ServiceRpcResponse = z.infer<typeof serviceRpcResponseSchema>;
