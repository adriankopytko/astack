import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { rejectedResultSchema } from './operation-result.js';

const noNul = z.string().refine((value) => !value.includes('\0'));
const absolutePath = noNul.refine(isAbsolute);
const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const maximumTimer = 2_147_483_647;

export const processRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    executable: noNul.min(1),
    args: z.array(noNul),
    cwd: absolutePath,
    env: z.record(z.string().regex(/^[^=\0]+$/), noNul),
    timeoutMs: z.number().int().positive().max(maximumTimer),
    maxCaptureBytes: byteCount.max(16 * 1024 * 1024).default(64 * 1024),
    terminationGraceMs: z.number().int().min(0).max(10_000).default(250),
    shutdownWaitMs: z.number().int().min(1).max(10_000).default(1000),
    artifacts: z
      .strictObject({ directory: absolutePath, maxBytesPerStream: byteCount.max(1024 ** 3) })
      .optional(),
  })
  .superRefine((value, context) => {
    if (!isAbsolute(value.executable)) {
      if (value.executable.includes('/') || !value.env.PATH) {
        context.addIssue({
          code: 'custom',
          message: 'Use an absolute executable or a bare name with an explicit PATH',
        });
      }
    }
  });

export const processOutputSchema = z
  .strictObject({
    text: z.string(),
    capturedBytes: byteCount,
    observedBytes: byteCount,
    truncated: z.boolean(),
    complete: z.boolean(),
    artifact: z
      .strictObject({
        path: absolutePath,
        writtenBytes: byteCount,
        truncated: z.boolean(),
        complete: z.boolean(),
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.capturedBytes > value.observedBytes ||
      value.truncated !== value.capturedBytes < value.observedBytes
    ) {
      context.addIssue({ code: 'custom', message: 'Capture counts and truncation must agree' });
    }

    if (value.artifact) {
      const artifact = value.artifact;

      if (
        artifact.writtenBytes > value.observedBytes ||
        artifact.truncated !== artifact.writtenBytes < value.observedBytes
      ) {
        context.addIssue({ code: 'custom', message: 'Artifact counts and truncation must agree' });
      }

      if (artifact.complete && (!value.complete || artifact.truncated)) {
        context.addIssue({
          code: 'custom',
          message: 'Complete artifacts require fully retained stream evidence',
        });
      }
    }
  });

export const processExecutionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    outcome: z.enum([
      'exited',
      'timed_out',
      'cancelled',
      'spawn_failed',
      'io_failed',
      'descendants_remaining',
    ]),
    pid: z.number().int().positive().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .nullable(),
    stdout: processOutputSchema,
    stderr: processOutputSchema,
    shutdown: z.strictObject({
      root: z.enum(['not_started', 'exited', 'unverified']),
      processGroup: z.enum(['not_started', 'absent', 'present', 'unknown']),
      termSent: z.boolean(),
      killSent: z.boolean(),
    }),
    error: z
      .strictObject({
        code: z.enum(['spawn_failed', 'artifact_setup_failed', 'output_failed', 'signal_failed']),
        systemCode: z.enum([
          'ENOENT',
          'EACCES',
          'EPERM',
          'ENOTDIR',
          'E2BIG',
          'EIO',
          'ENOSPC',
          'UNKNOWN',
        ]),
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    if (value.pid === null) {
      if (
        value.shutdown.root !== 'not_started' ||
        value.shutdown.processGroup !== 'not_started' ||
        value.exitCode !== null ||
        value.signal !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Unstarted execution cannot claim process evidence',
        });
      }
    } else if (
      value.shutdown.root === 'not_started' ||
      value.shutdown.processGroup === 'not_started'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A started process requires shutdown observations',
      });
    }

    if (value.shutdown.root === 'exited' && (value.exitCode === null) === (value.signal === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Exit evidence requires either a code or a signal',
      });
    }

    if (value.shutdown.root !== 'exited' && (value.exitCode !== null || value.signal !== null)) {
      context.addIssue({ code: 'custom', message: 'Exit evidence requires an observed root exit' });
    }

    if (value.outcome === 'exited' && value.shutdown.root !== 'exited') {
      context.addIssue({
        code: 'custom',
        message: 'Exited outcome requires an observed root exit',
      });
    }
  });

export const processResultSchema = z.union([processExecutionSchema, rejectedResultSchema]);
export type ProcessRequest = z.infer<typeof processRequestSchema>;
export type ProcessOutput = z.infer<typeof processOutputSchema>;
export type ProcessExecution = z.infer<typeof processExecutionSchema>;
export type ProcessResult = z.infer<typeof processResultSchema>;
