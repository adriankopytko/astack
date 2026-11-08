import { z } from 'zod';
import { implementationSubmitRequestSchema } from './implementation-task.js';
import { reviewSubmitRequestSchema } from './review-task.js';

/** A task submission selects the project; Astack chooses its owned checkout and branch. */
export const implementationWorkerSubmissionSchema = z
  .strictObject(implementationSubmitRequestSchema.shape)
  .omit({ checkoutId: true, branch: true, commit: true })
  .extend({ baseCommit: implementationSubmitRequestSchema.shape.commit.optional() })
  .refine(
    (value) =>
      new Set(value.instructionPaths).size === value.instructionPaths.length &&
      Buffer.byteLength(JSON.stringify(value)) <= 9000,
  );

export const reviewWorkerSubmissionSchema = z
  .strictObject(reviewSubmitRequestSchema.shape)
  .omit({ checkoutId: true, branch: true, commit: true })
  .refine(
    (value) =>
      new Set(value.instructionPaths).size === value.instructionPaths.length &&
      Buffer.byteLength(JSON.stringify(value)) <= 6000,
  );
