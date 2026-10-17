import { z } from 'zod';
import {
  serviceSubmitRequestSchema,
  serviceReadRequestSchema,
  serviceStatusSchema,
  serviceJobSchema,
} from './service.js';
import {
  implementationSubmitRequestSchema,
  implementationReadRequestSchema,
  implementationReadResultSchema,
  implementationSubmitResultSchema,
} from './implementation.js';
import {
  reviewSubmitRequestSchema,
  reviewReadRequestSchema,
  reviewReadResultSchema,
  reviewSubmitResultSchema,
} from './review.js';
import { createOperationResultSchema } from './operation-result.js';
import { createStateWriteResultSchema } from './state.js';

export const serviceRpcRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('status') }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('wake') }),
  serviceSubmitRequestSchema.extend({ operation: z.literal('submit') }),
  serviceReadRequestSchema.extend({ operation: z.literal('inspect') }),
  implementationSubmitRequestSchema.extend({ operation: z.literal('implement_submit') }),
  implementationReadRequestSchema.extend({ operation: z.literal('implement_inspect') }),
  reviewSubmitRequestSchema.extend({ operation: z.literal('review_submit') }),
  reviewReadRequestSchema.extend({ operation: z.literal('review_inspect') }),
]);
export const serviceRpcResponseSchema = z.union([
  createOperationResultSchema(serviceStatusSchema),
  createOperationResultSchema(serviceJobSchema.nullable()),
  createStateWriteResultSchema(serviceJobSchema),
  implementationReadResultSchema,
  implementationSubmitResultSchema,
  reviewReadResultSchema,
  reviewSubmitResultSchema,
]);
export type ServiceRpcRequest = z.infer<typeof serviceRpcRequestSchema>;
export type ServiceRpcResponse = z.infer<typeof serviceRpcResponseSchema>;
