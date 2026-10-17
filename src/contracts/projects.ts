import { z } from 'zod';
import { gitRepositoryInspectionSchema } from './git.js';
import {
  checkoutRecordSchema,
  projectIdSchema,
  projectRecordSchema,
  checkoutIdSchema,
} from './project-context.js';
import {
  stateAttemptSchema,
  stateIdSchema,
  stateRepositorySchema,
  createStateWriteResultSchema,
} from './state.js';
import { createOperationResultSchema } from './operation-result.js';

const path = checkoutRecordSchema.shape.rootPath;
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const directoryIdentity = z.strictObject({
  path,
  device: z.string().regex(/^[0-9]+$/),
  inode: z.string().regex(/^[0-9]+$/),
});
export const checkoutLocationSchema = z.strictObject({
  root: directoryIdentity,
  gitDirectory: directoryIdentity,
  commonDirectory: directoryIdentity,
});
export const registeredProjectSchema = z
  .strictObject({
    project: projectRecordSchema,
    repository: stateRepositorySchema,
    registeredAt: timestamp.nullable(),
  })
  .refine((value) => value.project.id.length > 0);
export const registryCheckoutSchema = z
  .strictObject({
    checkout: checkoutRecordSchema,
    registered: z.boolean(),
    location: checkoutLocationSchema.nullable(),
  })
  .refine((value) => value.registered === (value.location !== null));
export const runBindingSchema = z.strictObject({
  id: stateIdSchema,
  jobId: stateIdSchema,
  projectId: projectIdSchema,
  repositoryId: stateRepositorySchema.shape.id,
  checkoutId: checkoutIdSchema,
  branch: stateAttemptSchema.shape.branch,
  commit: stateAttemptSchema.shape.commit,
});
export const projectRegistrationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  path,
  projectId: projectIdSchema.optional(),
});
export const projectRegistrationSchema = z
  .strictObject({
    project: projectRecordSchema,
    repository: stateRepositorySchema,
    checkout: checkoutRecordSchema,
    projectRegisteredAt: timestamp,
    checkoutRegisteredAt: timestamp,
    location: checkoutLocationSchema,
  })
  .superRefine((value, context) => {
    if (
      value.checkout.projectId !== value.project.id ||
      value.checkout.repositoryId !== value.repository.id ||
      value.checkout.gitCommonDirectory !== value.repository.commonDirectory ||
      value.location.root.path !== value.checkout.rootPath ||
      value.location.commonDirectory.path !== value.repository.commonDirectory
    ) {
      context.addIssue({ code: 'custom', message: 'Registration identities must agree' });
    }
  });
export const projectRegistrationResultSchema =
  createStateWriteResultSchema(projectRegistrationSchema);
export const projectSelectionRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema.optional(),
    checkoutId: checkoutIdSchema.optional(),
    runId: stateIdSchema.optional(),
    path: path.optional(),
    callerDirectory: path.optional(),
  })
  .refine(
    (value) =>
      value.projectId !== undefined ||
      value.checkoutId !== undefined ||
      value.runId !== undefined ||
      value.path !== undefined ||
      value.callerDirectory !== undefined,
  );
export const projectSelectionSchema = z
  .strictObject({
    source: z.enum([
      'saved-run',
      'explicit-checkout',
      'explicit-project',
      'explicit-path',
      'caller-directory',
    ]),
    registration: z.enum(['registered', 'unregistered-repository', 'unregistered-checkout']),
    project: registeredProjectSchema.nullable(),
    checkout: registryCheckoutSchema.nullable(),
    git: gitRepositoryInspectionSchema,
    run: runBindingSchema.nullable(),
    readiness: z.strictObject({
      delegation: z.literal('unavailable'),
      reasons: z.array(
        z.enum([
          'registration_required',
          'execution_policy_not_checked',
          'delegation_not_implemented',
        ]),
      ),
      providers: z.strictObject({
        git: z.literal('ready'),
        codex: z.literal('not_checked'),
        herdr: z.literal('not_checked'),
        github: z.literal('not_checked'),
      }),
      configuration: z.strictObject({
        source: z.literal('none'),
        status: z.literal('not_checked'),
      }),
    }),
  })
  .superRefine((value, context) => {
    const project = value.project;
    const checkout = value.checkout;
    const registered = checkout?.registered === true && project?.registeredAt != null;
    const expected = registered
      ? 'registered'
      : project?.registeredAt != null
        ? 'unregistered-checkout'
        : 'unregistered-repository';
    const reasons = value.readiness.reasons;

    if (
      value.registration !== expected ||
      reasons.includes('registration_required') !== !registered ||
      !reasons.includes('execution_policy_not_checked') ||
      !reasons.includes('delegation_not_implemented') ||
      (checkout &&
        (checkout.checkout.rootPath !== value.git.checkout.rootPath ||
          checkout.checkout.gitCommonDirectory !== value.git.repository.commonDirectory)) ||
      (project &&
        (project.repository.commonDirectory !== value.git.repository.commonDirectory ||
          project.repository.objectFormat !== value.git.repository.objectFormat)) ||
      (project &&
        checkout &&
        (checkout.checkout.projectId !== project.project.id ||
          checkout.checkout.repositoryId !== project.repository.id)) ||
      (value.source === 'saved-run') !== (value.run !== null) ||
      (value.run &&
        (value.run.projectId !== project?.project.id ||
          value.run.repositoryId !== project?.repository.id ||
          value.run.checkoutId !== checkout?.checkout.id)) ||
      (value.source === 'explicit-project' &&
        checkout?.checkout.id !== project?.project.primaryCheckoutId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Selection facts, registration, and readiness must agree',
      });
    }
  });
export const projectSelectionResultSchema = createOperationResultSchema(projectSelectionSchema);
export const projectListRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  after: projectIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const projectListSchema = z.strictObject({
  items: z.array(
    z.strictObject({ project: registeredProjectSchema, primaryCheckout: checkoutRecordSchema }),
  ),
  nextCursor: projectIdSchema.nullable(),
});
export const projectListResultSchema = createOperationResultSchema(projectListSchema);
export type RegisteredProject = z.infer<typeof registeredProjectSchema>;
export type RegistryCheckout = z.infer<typeof registryCheckoutSchema>;
export type RunBinding = z.infer<typeof runBindingSchema>;
export type ProjectRegistrationRequest = z.infer<typeof projectRegistrationRequestSchema>;
export type ProjectRegistration = z.infer<typeof projectRegistrationSchema>;
export type ProjectRegistrationResult = z.infer<typeof projectRegistrationResultSchema>;
export type ProjectSelectionRequest = z.infer<typeof projectSelectionRequestSchema>;
export type ProjectSelection = z.infer<typeof projectSelectionSchema>;
export type ProjectListRequest = z.infer<typeof projectListRequestSchema>;
export type ProjectList = z.infer<typeof projectListSchema>;
export type CheckoutLocation = z.infer<typeof checkoutLocationSchema>;
