export { getApplicationInfo } from './application/get-application-info.js';
export { startLocalService } from './host/local-service.js';
export { requestLocalService } from './adapters/local/service-client.js';
export { acquireCoordinatorOwnership } from './adapters/state/coordinator-ownership.js';
export {
  createServiceCoordinator,
  submitServiceJob,
  inspectServiceJob,
  type ServiceDependencies,
} from './application/service.js';
export type { ServiceStore, ServiceWorkerRuntime, CoordinatorOwnership } from './ports/service.js';
export {
  serviceLimitsSchema,
  serviceSubmitRequestSchema,
  serviceEntrySchema,
  serviceJobSchema,
  serviceStatusSchema,
  serviceRpcRequestSchema,
  serviceRpcResponseSchema,
  workerObservationSchema,
  type ServiceSubmitRequest,
  type ServiceEntry,
  type ServiceJob,
  type ServiceLimits,
  type ServiceStatus,
  type ServiceRpcRequest,
  type ServiceRpcResponse,
  type WorkerObservation,
} from './contracts/service.js';
export { ConfigurationReadError } from './core/configuration-error.js';
export {
  resolveConfiguration,
  acceptConfiguredJob,
  checkConfigurationDispatch,
  type ConfigurationDependencies,
} from './application/configuration.js';
export {
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
} from './adapters/filesystem/configuration.js';
export type {
  ConfigurationReader,
  ConfigurationProbe,
  ConfigurationPrerequisites,
} from './ports/configuration.js';
export {
  configurationPatchSchema,
  portableConfigurationSchema,
  effectiveConfigurationSchema,
  hostConfigurationPolicySchema,
  configurationRequestSchema,
  configurationSnapshotSchema,
  configurationResolutionSchema,
  configurationResultSchema,
  type ConfigurationPatch,
  type EffectiveConfiguration,
  type HostConfigurationPolicy,
  type ConfigurationRequest,
  type ConfigurationSnapshot,
  type ConfigurationDiagnostic,
  type ConfigurationResolution,
} from './contracts/configuration.js';
export {
  applicationInfoSchema,
  applicationInfoRequestSchema,
  applicationInfoResultSchema,
  type ApplicationInfo,
  type ApplicationInfoRequest,
} from './contracts/application-info.js';
export { resolveProjectContext } from './application/resolve-project-context.js';
export {
  projectIdSchema,
  checkoutIdSchema,
  repositoryIdSchema,
  projectRecordSchema,
  checkoutRecordSchema,
  projectContextRequestSchema,
  projectContextSchema,
  projectContextResultSchema,
  type ProjectId,
  type CheckoutId,
  type RepositoryId,
  type ProjectRecord,
  type CheckoutRecord,
  type ProjectContextRequest,
  type ProjectContext,
} from './contracts/project-context.js';
export {
  operationErrorSchema,
  rejectedResultSchema,
  type OperationError,
  type OperationErrorCode,
  type CompletedResult,
  type RejectedResult,
  type OperationResult,
} from './contracts/operation-result.js';
export type { ProjectContextReader } from './ports/project-context-reader.js';
export { executeProcess } from './application/execute-process.js';
export { nodeProcessRunner } from './core/node-process-runner.js';
export {
  processRequestSchema,
  processOutputSchema,
  processExecutionSchema,
  processResultSchema,
  type ProcessRequest,
  type ProcessOutput,
  type ProcessExecution,
  type ProcessResult,
} from './contracts/process.js';
export type { ProcessRunner } from './ports/process-runner.js';
export { writeManagedFile, inspectManagedFile } from './application/managed-files.js';
export {
  nodeManagedFileStore,
  createNodeManagedFileStore,
  type ManagedWriteProgress,
} from './core/node-managed-file-store.js';
export {
  managedFileRequestSchema,
  inspectManagedFileRequestSchema,
  managedFileRecordSchema,
  managedWriteIntentSchema,
  managedFileResultSchema,
  managedFileInspectionSchema,
  type ManagedFileRequest,
  type ManagedFileRecord,
  type ManagedWriteIntent,
  type ManagedFileResult,
  type ManagedFileInspection,
  type InspectManagedFileRequest,
} from './contracts/managed-files.js';
export type { ManagedFileStore } from './ports/managed-file-store.js';
export { inspectGitRepository } from './application/inspect-git-repository.js';
export { createGitInspector, type GitInspectorOptions } from './adapters/git/git-inspector.js';
export type { GitInspector } from './ports/git-inspector.js';
export {
  gitInspectionRequestSchema,
  gitRepositoryInspectionSchema,
  gitInspectionResultSchema,
  type GitInspectionRequest,
  type GitRepositoryInspection,
  type GitInspectionResult,
  type GitHead,
  type GitRef,
  type GitStatusEntry,
  type GitWorktree,
  type GitRemoteEndpoint,
} from './contracts/git.js';
export {
  openSqliteState,
  type StateOpenResult,
  type SqliteStateDependencies,
} from './adapters/state/open-sqlite-state.js';
export {
  saveStateProject,
  acceptStateJob,
  prepareStateAttempt,
  claimStateEffect,
  resolveStateEffect,
  recordStateResult,
  retainStateResource,
  releaseStateResource,
  inspectStateRecord,
} from './application/state.js';
export type { StateStore } from './ports/state-store.js';
export {
  stateOpenRequestSchema,
  stateProjectRequestSchema,
  stateJobRequestSchema,
  configuredJobRequestSchema,
  stateAttemptRequestSchema,
  stateClaimRequestSchema,
  stateEffectResolutionRequestSchema,
  stateResultRequestSchema,
  stateResourceRequestSchema,
  stateResourceReleaseRequestSchema,
  stateInspectionRequestSchema,
  stateJobSchema,
  stateAttemptSchema,
  stateEffectSchema,
  stateResultSchema,
  stateResourceSchema,
  stateRecordSchema,
  stateInspectionResultSchema,
  createStateWriteResultSchema,
  type StateWriteResult,
  type StateJob,
  type StateAttempt,
  type StateEffect,
  type StateResult,
  type StateResource,
  type StateRecord,
  type StateOpenRequest,
  type StateProjectRequest,
  type StateJobRequest,
  type ConfiguredJobRequest,
  type StateAttemptRequest,
  type StateClaimRequest,
  type StateEffectResolutionRequest,
  type StateResultRequest,
  type StateResourceRequest,
  type StateResourceReleaseRequest,
  type StateInspectionRequest,
  type StateEffectIntent,
  type StateResourceIntent,
  type StateRepository,
  type StateClaim,
} from './contracts/state.js';
export {
  registerProject,
  type ProjectRegistrationDependencies,
} from './application/register-project.js';
export { selectProjectContext } from './application/select-project-context.js';
export { listProjects } from './application/list-projects.js';
export type { ProjectDependencies } from './application/project-facts.js';
export type { ProjectRegistry } from './ports/project-registry.js';
export type { CheckoutIdentityReader } from './ports/checkout-identity-reader.js';
export { nodeCheckoutIdentityReader } from './adapters/filesystem/checkout-identity.js';
export {
  projectRegistrationRequestSchema,
  projectRegistrationSchema,
  projectRegistrationResultSchema,
  projectSelectionRequestSchema,
  projectSelectionSchema,
  projectSelectionResultSchema,
  projectListRequestSchema,
  projectListResultSchema,
  type RegisteredProject,
  type RegistryCheckout,
  type CheckoutLocation,
  type RunBinding,
  type ProjectRegistrationRequest,
  type ProjectRegistration,
  type ProjectRegistrationResult,
  type ProjectSelectionRequest,
  type ProjectSelection,
  type ProjectListRequest,
  type ProjectList,
} from './contracts/projects.js';
export {
  prepareWorktree,
  inspectWorktree,
  removeWorktree,
  reconcileWorktree,
} from './application/worktrees.js';
export type { WorktreeDependencies } from './application/worktree-evidence.js';
export { createNodeWorktreeFiles } from './adapters/filesystem/worktree-files.js';
export { createWorktreeGit } from './adapters/git/worktree-git.js';
export type { WorktreeStore, WorktreeFiles, WorktreeGit } from './ports/worktrees.js';
export {
  worktreePrepareRequestSchema,
  worktreeIdRequestSchema,
  worktreeReconcileRequestSchema,
  worktreeIntentSchema,
  worktreeRecordSchema,
  worktreeObservationSchema,
  worktreeResultSchema,
  type WorktreeIntent,
  type WorktreeRecord,
  type WorktreeObservation,
  type WorktreeReason,
  type WorktreeResult,
  type WorktreePrepareRequest,
  type WorktreeReconcileRequest,
} from './contracts/worktrees.js';
