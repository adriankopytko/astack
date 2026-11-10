import { createReviewCommitFetcher } from '../adapters/git/review-commit.js';
import { createBaseCommitFetcher } from '../adapters/git/base-commit.js';
import { submitGenericWorker } from '../application/generic-worker-submission.js';
import { createGenericHandoffRuntime } from '../application/generic-handoff.js';
import { createPrivateArtifactDirectory, openPrivateArtifact } from '../core/private-artifacts.js';
import { createMainBaseResolver } from '../adapters/git/main-base.js';
import { enqueueHandoff, type HandoffContextReader } from '../application/enqueue-handoff.js';
import { workerQueueReceipt } from '../contracts/worker-queue.js';
import { prepareWorkerWorktree, reconcileWorkerWorktree } from '../application/worker-worktree.js';
import { createWorktreeGit } from '../adapters/git/worktree-git.js';
import type { HerdrDependencies } from '../application/herdr.js';
import type { HerdrProvider } from '../ports/herdr.js';
import { homedir } from 'node:os';
import {
  initializeProject,
  type InitializationDependencies,
} from '../application/initialization.js';
import { nodeInitializationFiles } from '../adapters/filesystem/initialization.js';
import { nodeManagedFileStore } from '../core/node-managed-file-store.js';
import { createBundledSkillReader } from '../adapters/filesystem/skill-bundle.js';
import { nodeSkillDirectories } from '../adapters/filesystem/skill-directories.js';
import { createHerdrCliProvider } from '../adapters/herdr/cli-provider.js';
import { watchHerdrPane } from '../adapters/herdr/event-stream.js';
import { nodeHerdrEndpointReader } from '../adapters/filesystem/herdr-endpoint.js';
import { requestCleanup, controlCleanup, inspectCleanup } from '../application/cleanup.js';
import { createAgentHooks } from './agent-hooks.js';
import { createAgentPorts } from '../application/agent-ports.js';
import { createCleanupExecutor, suspendCleanupExecutor } from '../application/automatic-cleanup.js';
import { composeCleanupDependencies } from './cleanup.js';
import { prepareStateDirectory } from '../adapters/state/state-directory.js';
import {
  inspectRun,
  acceptRunReport,
  respondToRun,
  resumeRun,
  cancelRun,
  readRunEvents,
  readRunCursor,
  checkpointRunEvents,
  type RunDependencies,
} from '../application/runs.js';
import { nodeRunArtifactReader } from '../adapters/filesystem/run-artifacts.js';
import { nodeRunEventWaiter } from '../adapters/local/run-waiter.js';
import type { ImplementationWorkerInput } from '../ports/implementation.js';
import type { RunShutdownVerifier, RunWorkerControl } from '../ports/runs.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serviceRpcRequestSchema, type ServiceRpcResponse } from '../contracts/service-rpc.js';
import { serviceRunRequestSchema } from '../contracts/service.js';
import { rejected, completed, type OperationResult } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { gitExecutable, hostExecutable } from '../core/host-git.js';
import { hasFileCode } from '../core/file-paths.js';
import { nodeProcessRunner } from '../core/node-process-runner.js';
import { openSqliteState } from '../adapters/state/open-sqlite-state.js';
import { acquireCoordinatorOwnership } from '../adapters/state/coordinator-ownership.js';
import { stateRejection } from '../adapters/state/errors.js';
import { createGitInspector } from '../adapters/git/git-inspector.js';
import { nodeCheckoutIdentityReader } from '../adapters/filesystem/checkout-identity.js';
import {
  createNodeConfigurationReader,
  createNodeConfigurationProbe,
} from '../adapters/filesystem/configuration.js';
import {
  createServiceCoordinator,
  submitServiceJob,
  inspectServiceJob,
  type ServiceDependencies,
} from '../application/service.js';
import type { TaskDeliveryDependencies } from '../application/task-delivery.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { nodeImplementationContextReader } from '../adapters/filesystem/implementation-context.js';
import { createGhReadPrimitives } from '../adapters/github/read.js';
import { composeCodexHerdrRuntime } from './codex-runtime.js';
import { listenLocalService } from '../service/local-transport.js';
import type { CoordinatorOwnership, ServiceWorkerRuntime } from '../ports/service.js';

/** Explicit composition boundary shared by the CLI and library hosts; construction imports do no IO. */
export async function startLocalService(
  input: unknown,
  options: {
    runtimes?: readonly ServiceWorkerRuntime[];
    initializationHerdrProvider?: HerdrProvider;
    implementationBase?: {
      resolve(root: string, signal?: AbortSignal): Promise<OperationResult<string>>;
    };
    workerSetupProvider?: HerdrProvider;
    cleanup?: boolean;
    cleanupHerdrExecutable?: string;
    cleanupShutdown?: RunShutdownVerifier;
    githubExecutable?: string;
    githubContext?: HandoffContextReader;
    runWorkerInput?: ImplementationWorkerInput;
    runWorkerControl?: RunWorkerControl;
    codexHerdr?: { herdrExecutable?: string; codexExecutable?: string };
  } = {},
) {
  const request = parseOperationRequest(serviceRunRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return rejected('unsupported_platform', 'The local service requires Linux or macOS.');
  }

  let ownership: CoordinatorOwnership | undefined;
  let closeState = () => {};

  try {
    const prepared = await prepareStateDirectory(request.value.stateDirectory, false);
    ownership = await acquireCoordinatorOwnership(prepared.root.path);
    const opened = await openSqliteState({ schemaVersion: 1, stateDirectory: prepared.root.path });

    if (opened.outcome !== 'opened') {
      ownership.release();

      return opened;
    }

    closeState = () => {
      opened.store.close();
    };

    const stateStore = opened.store;
    const executable = await gitExecutable(request.value.gitExecutable);

    if (!executable) {
      ownership.release();
      opened.store.close();

      return rejected(
        'git_unavailable',
        'Select a trusted absolute Git executable or add Git to host PATH.',
      );
    }

    const sessionId = `service-${randomUUID()}`;
    const dependencies: ServiceDependencies = {
      registry: opened.registry,
      queue: opened.service,
      workerQueue: opened.workerQueue,
      git: createGitInspector({ executable, runner: nodeProcessRunner }),
      identity: nodeCheckoutIdentityReader,
      configuration: createNodeConfigurationReader(opened.registry, opened.store),
      prerequisites: createNodeConfigurationProbe(
        (name) => Object.hasOwn(process.env, name) && Boolean(process.env[name]),
      ),
      now: Date.now,
      nextId: (kind) => `${kind}-${randomUUID()}`,
    };
    const agentPorts = createAgentPorts({
      configuration: dependencies.configuration,
      allocations: opened.allocations,
    });
    dependencies.agentHooks = createAgentHooks({
      ...dependencies,
      state: opened.store,
      errors: opened.errors,
      ports: agentPorts,
    });
    const cleanupDependencies = composeCleanupDependencies(
      opened,
      executable,
      options.cleanup
        ? await hostExecutable(
            'herdr',
            options.cleanupHerdrExecutable ?? options.codexHerdr?.herdrExecutable,
          )
        : null,
    );

    if (options.cleanupShutdown) {
      cleanupDependencies.shutdown = options.cleanupShutdown;
    }

    if (!options.cleanup) {
      const suspended = suspendCleanupExecutor(opened.cleanups, Date.now);

      if (suspended.outcome !== 'completed') {
        ownership.release();
        opened.store.close();

        return suspended;
      }
    }

    const assignmentDependencies: TaskDeliveryDependencies = {
      ...dependencies,
      worktrees: opened.worktrees,
      files: createNodeWorktreeFiles(join(opened.stateDirectory, 'worktrees')),
      instructions: nodeImplementationContextReader,
    };
    const gh = await hostExecutable('gh', options.githubExecutable);

    const environment: Record<string, string> = {};

    for (const key of [
      'HOME',
      'PATH',
      'GH_CONFIG_DIR',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]) {
      const value = process.env[key];

      if (value !== undefined) {
        environment[key] = value;
      }
    }

    const githubReads = gh
      ? createGhReadPrimitives({
          executable: gh,
          runner: nodeProcessRunner,
          environment,
          now: Date.now,
        })
      : null;
    let workerInput: ImplementationWorkerInput = options.runWorkerInput ?? {
      receipt({ attemptId, key }) {
        const result = opened.runtime.action(attemptId, key);

        if (result.outcome === 'rejected' || result.value === null) {
          return result;
        }

        const action = result.value;

        return action.kind === 'input'
          ? completed({ key: action.key, digest: action.digest, state: action.state })
          : rejected('runtime_conflict', 'Input key identifies a different action.');
      },
      submit: async () =>
        rejected(
          'run_control_unavailable',
          'Enable the approved runtime before resuming a worker.',
        ),
    };
    let workerControl: RunWorkerControl = options.runWorkerControl ?? {
      interrupt: async () =>
        rejected(
          'run_control_unavailable',
          'Enable the approved runtime before interrupting a worker.',
        ),
    };
    const runtimes = [...(options.runtimes ?? [])];
    let workerProvider = options.workerSetupProvider;

    if (options.codexHerdr) {
      const herdr = await hostExecutable('herdr', options.codexHerdr.herdrExecutable);
      const codex = await hostExecutable('codex', options.codexHerdr.codexExecutable);

      if (!herdr || !codex) {
        ownership.release();
        opened.store.close();

        return rejected(
          'runtime_unavailable',
          'Select trusted absolute Herdr and Codex executables before enabling codex-herdr.',
        );
      }

      workerProvider ??= createHerdrCliProvider({
        executable: herdr,
        runner: nodeProcessRunner,
        endpoint: nodeHerdrEndpointReader,
      });
      const codexRuntime = composeCodexHerdrRuntime({
        opened,
        dependencies,
        herdrExecutable: herdr,
        codexExecutable: codex,
        agentPorts,
      });
      runtimes.push(codexRuntime.runtime);
      workerInput = options.runWorkerInput ?? codexRuntime.workerInput;
      workerControl = options.runWorkerControl ?? codexRuntime.workerControl;
    }

    for (let index = 0; index < runtimes.length; index++) {
      runtimes[index] = createGenericHandoffRuntime({
        runtime: runtimes[index]!,
        dependencies: assignmentDependencies,
        workerInput,
      });
    }

    const workerHerdr: HerdrDependencies | null = workerProvider
      ? {
          ...dependencies,
          state: opened.store,
          herdr: opened.herdr,
          provider: workerProvider,
          files: assignmentDependencies.files,
          newId: randomUUID,
          agentPorts,
        }
      : null;
    const managedRoot = join(opened.stateDirectory, 'worktrees');
    const workerWorktrees = {
      ...dependencies,
      store: opened.worktrees,
      files: assignmentDependencies.files,
      effects: createWorktreeGit({ executable, runner: nodeProcessRunner }),
      managedRoot,
      now: Date.now,
      nextId: (kind: 'worktree' | 'checkout' | 'operation' | 'marker') => `${kind}-${randomUUID()}`,
    };

    const runDependencies: RunDependencies = {
      ...assignmentDependencies,
      runs: opened.runs,
      artifacts: nodeRunArtifactReader,
      workerInput,
      workerControl,
    };

    let fatal = false;
    let closing: Promise<OperationResult<{ closed: true }>> | null = null;
    let resolveClosed: (result: OperationResult<{ closed: true }>) => void = () => {};

    const closed = new Promise<OperationResult<{ closed: true }>>((resolve) => {
      resolveClosed = resolve;
    });
    const availableWorkerRuntimes = () => ({
      handoff: runtimes
        .filter((runtime) => runtime.workflows?.includes('handoff'))
        .flatMap((runtime) => [runtime.id, ...(runtime.aliases ?? [])]),
    });
    const eventWatches = new Map<string, () => void>();
    const coordinator = createServiceCoordinator({
      sessionId,
      limits: request.value.limits,
      runtimes,
      dependencies,
      onObservation(job, observation) {
        const attemptId = job.attempt.id;

        if (!options.codexHerdr || observation.state !== 'running') {
          if (observation.state === 'quiescent' || observation.state === 'not_started') {
            eventWatches.get(attemptId)?.();
            eventWatches.delete(attemptId);
          }

          return;
        }

        if (eventWatches.has(attemptId)) {
          return;
        }

        const saved = opened.runtime.read(attemptId);

        if (
          saved.outcome !== 'completed' ||
          saved.value?.phase !== 'ready' ||
          !saved.value.space.handle
        ) {
          return;
        }

        eventWatches.set(
          attemptId,
          watchHerdrPane({
            server: saved.value.space.server,
            paneId: saved.value.space.handle.paneId,
            endpoint: nodeHerdrEndpointReader,
            changed: () => coordinator.wake(),
          }),
        );
      },
      async afterCycle(signal) {
        if (!workerHerdr) {
          return false;
        }

        const claimed = opened.workerQueue.claim(request.value.limits, availableWorkerRuntimes());

        if (claimed.outcome !== 'persisted') {
          throw new Error('Could not claim queued worker capacity.');
        }

        const item = claimed.value;

        if (!item) {
          return false;
        }

        const pinnedConfiguration = {
          ...dependencies.configuration,
          readPolicy: async (projectId: string) =>
            projectId === item.request.submission.projectId ? item.policy : null,
        };
        const nextId = (kind: 'job' | 'attempt' | 'effect' | 'claim') =>
          kind === 'job' ? item.id : `${kind}-${randomUUID()}`;
        const assignment = {
          ...assignmentDependencies,
          configuration: pinnedConfiguration,
          nextId,
        };
        let result;

        try {
          let contextPath: string | undefined;

          if (item.contextSnapshot) {
            const directory = await createPrivateArtifactDirectory(opened.stateDirectory, item.id);
            const artifact = await openPrivateArtifact(directory, 'github-context.json');

            try {
              await artifact.file.writeFile(`${JSON.stringify(item.contextSnapshot, null, 2)}\n`);
              await artifact.file.sync();
              contextPath = artifact.path;
            } finally {
              await artifact.file.close();
            }
          }

          result = await submitGenericWorker(
            item.request.submission,
            {
              assignment,
              worktrees: workerWorktrees,
              herdr: workerHerdr,
              stateDirectory: opened.stateDirectory,
              ...(contextPath ? { contextPath } : {}),
              ...(item.contextSnapshot ? { contextSnapshot: item.contextSnapshot } : {}),
              reviewCommit: createReviewCommitFetcher({
                executable,
                githubExecutable: gh,
                runner: nodeProcessRunner,
                environment,
              }),
              baseCommitFetcher: createBaseCommitFetcher({
                executable,
                runner: nodeProcessRunner,
                environment: process.env,
              }),
              baseResolver:
                options.implementationBase ??
                createMainBaseResolver({
                  executable,
                  runner: nodeProcessRunner,
                  environment: process.env,
                }),
            },
            signal,
          );
        } catch {
          result = rejected(
            'state_reconciliation_required',
            'Worker preparation stopped unexpectedly; inspect its saved state.',
          );
        }

        if (result.outcome === 'persisted') {
          const acceptedId = result.value.job.id;

          if (acceptedId !== item.id) {
            const alias = opened.workerQueue.alias(item.id, acceptedId);

            if (alias.outcome !== 'persisted') {
              throw new Error('Could not save the existing handoff assignment.');
            }
          }

          return true;
        }

        const error =
          'error' in result
            ? result.error
            : {
                code: 'state_reconciliation_required',
                message: 'Worker preparation could not be confirmed.',
              };
        const bounded = { code: error.code, message: error.message.slice(0, 2048) };
        const uncertain =
          result.outcome === 'uncertain' || error.code === 'state_reconciliation_required';
        const saved = uncertain
          ? opened.workerQueue.uncertain(item.id, bounded)
          : opened.workerQueue.block(item.id, bounded);

        if (saved.outcome !== 'persisted') {
          throw new Error('Could not record worker preparation outcome.');
        }

        opened.errors.append({
          operation: 'worker_prepare',
          projectId: item.request.submission.projectId,
          jobId: item.id,
          ...bounded,
        });

        return true;
      },
      onFailure: () => {
        fatal = true;
        void close();
      },
    });
    const cleanupExecutor = options.cleanup
      ? createCleanupExecutor(cleanupDependencies, () => {
          fatal = true;
          void close();
        })
      : null;
    const transport = await listenLocalService({
      stateDirectory: opened.stateDirectory,
      sessionId,
      afterHandle(input, result) {
        if (result.outcome !== 'rejected' && result.outcome !== 'uncertain') {
          return;
        }

        const parsed = serviceRpcRequestSchema.safeParse(input);
        const request = parsed.success ? parsed.data : null;
        const operation = request?.operation ?? 'invalid_request';
        const projectId = request && 'projectId' in request ? (request.projectId ?? null) : null;
        const jobId = request && 'jobId' in request ? (request.jobId ?? null) : null;
        opened.errors.append({
          operation,
          projectId,
          jobId,
          code: result.error.code,
          message: result.error.message.slice(0, 2048),
        });
      },
      afterResponse(input) {
        const parsed = serviceRpcRequestSchema.safeParse(input);

        if (parsed.success && parsed.data.operation === 'stop') {
          void close();
        }
      },
      async handle(input, signal): Promise<ServiceRpcResponse> {
        const parsed = parseOperationRequest(serviceRpcRequestSchema, input);

        if (!parsed.valid) {
          return parsed.result;
        }

        if (closing) {
          return rejected(
            'service_stopping',
            'Service is stopping; accepted intent remains in local state.',
          );
        }

        const request = parsed.value;

        switch (request.operation) {
          case 'worker_worktree_prepare': {
            if (!workerHerdr) {
              return rejected(
                'runtime_unavailable',
                'The Herdr worker runtime is unavailable. Install Herdr and Codex, then restart the service.',
              );
            }

            const { operation: _operation, ...value } = request;

            return completed({
              workerWorktree: await prepareWorkerWorktree(
                value,
                { worktrees: workerWorktrees, herdr: workerHerdr },
                signal,
              ),
            });
          }

          case 'worker_worktree_reconcile': {
            if (!workerHerdr) {
              return rejected(
                'runtime_unavailable',
                'The Herdr worker runtime is unavailable. Install Herdr and Codex, then restart the service.',
              );
            }

            const { operation: _operation, ...value } = request;
            const result = await reconcileWorkerWorktree(
              value,
              { worktrees: workerWorktrees, herdr: workerHerdr },
              signal,
            );

            if (result.outcome === 'reconciled' && result.record.reconciliation) {
              const resumed = opened.workerQueue.reconciled(result.record);

              if (resumed.outcome !== 'persisted') {
                return resumed;
              }

              if (resumed.value?.state === 'queued') {
                coordinator.wake();
              }
            }

            return completed({ workerWorktree: result });
          }

          case 'handoff_submit': {
            if (!workerHerdr) {
              return rejected(
                'runtime_unavailable',
                'The Herdr worker runtime is unavailable. Install Herdr and Codex, then restart the service.',
              );
            }

            const { operation: _operation, ...submission } = request;
            const queueDependencies: Parameters<typeof enqueueHandoff>[1] = {
              ...dependencies,
              workerQueue: opened.workerQueue,
              available: availableWorkerRuntimes().handoff ?? [],
              ...(githubReads
                ? {
                    githubContext: {
                      async read({ reference, root }, contextSignal) {
                        const query = {
                          repository: { host: reference.host, repository: reference.repository },
                          number: reference.number,
                          root,
                          maxAgeMs: 60000,
                        };
                        const label = `${reference.host}/${reference.repository}#${reference.number}`;

                        if (reference.kind === 'issue') {
                          const result = await githubReads.issue(query, contextSignal);

                          return result.outcome === 'rejected'
                            ? result
                            : completed({
                                kind: 'issue' as const,
                                title: result.value.value.title,
                                body: result.value.value.body,
                                reference: label,
                                author: result.value.value.author,
                                state: result.value.value.state,
                                updatedAt: result.value.value.updatedAt,
                                observedAt: result.value.observedAt,
                              });
                        }

                        const result = await githubReads.pullRequest(query, contextSignal);

                        return result.outcome === 'rejected'
                          ? result
                          : completed({
                              kind: 'pr' as const,
                              title: result.value.value.title,
                              body: result.value.value.body,
                              reference: label,
                              author: result.value.value.author,
                              state: result.value.value.state,
                              observedAt: result.value.observedAt,
                              headSha: result.value.value.target.sha,
                              baseSha: result.value.value.baseSha,
                            });
                      },
                    },
                  }
                : {}),
              ...(options.githubContext ? { githubContext: options.githubContext } : {}),
              nextId: () => submission.key,
              now: Date.now,
            };
            const result = await enqueueHandoff(submission, queueDependencies, signal);

            if (result.outcome === 'persisted') {
              coordinator.wake();
            }

            return result;
          }

          case 'project_initialize': {
            const common = {
              registry: opened.registry,
              git: createGitInspector({
                executable: request.gitExecutable,
                runner: nodeProcessRunner,
              }),
              identity: nodeCheckoutIdentityReader,
              configuration: createNodeConfigurationReader(opened.registry, opened.store),
              prerequisites: createNodeConfigurationProbe((name) => Boolean(process.env[name])),
            };
            const initialization: InitializationDependencies = {
              ...common,
              now: Date.now,
              nextId: (kind) => `${kind}-${randomUUID()}`,
              files: nodeManagedFileStore,
              layout: nodeInitializationFiles,
              skills: {
                bundle: createBundledSkillReader(),
                directories: nodeSkillDirectories,
                files: nodeManagedFileStore,
              },
              userSkillsRoot: request.userSkillsRoot,
              defaultHerdrTarget: {
                session: 'default',
                socketPath: join(homedir(), '.config', 'herdr', 'herdr.sock'),
              },
              worktrees: opened.worktrees,
              herdr: {
                ...common,
                state: opened.store,
                herdr: opened.herdr,
                files: createNodeWorktreeFiles(join(opened.stateDirectory, 'worktrees')),
                newId: randomUUID,
                provider:
                  options.initializationHerdrProvider ??
                  (request.herdrExecutable
                    ? createHerdrCliProvider({
                        executable: request.herdrExecutable,
                        runner: nodeProcessRunner,
                        endpoint: nodeHerdrEndpointReader,
                      })
                    : {
                        snapshot: async () =>
                          rejected(
                            'herdr_unavailable',
                            'Select a trusted Herdr executable to prepare the project space.',
                          ),
                        createPrimary: async () =>
                          rejected('herdr_unavailable', 'Herdr is unavailable.'),
                      }),
              },
            };

            return completed(await initializeProject(request.request, initialization, signal));
          }

          case 'run_inspect':
            return inspectRun({ schemaVersion: 1, jobId: request.jobId }, runDependencies, signal);
          case 'run_events': {
            const { operation: _operation, ...value } = request;

            return readRunEvents(
              value,
              { runs: opened.runs, now: () => performance.now(), waiter: nodeRunEventWaiter },
              signal,
            );
          }

          case 'run_cursor': {
            const { operation: _operation, ...value } = request;

            return readRunCursor(value, runDependencies);
          }

          case 'run_checkpoint': {
            const { operation: _operation, ...value } = request;

            return checkpointRunEvents(value, runDependencies);
          }

          case 'run_report': {
            const { operation: _operation, ...value } = request;
            const result = await acceptRunReport(value, runDependencies, signal);

            if (result.outcome === 'persisted') {
              coordinator.wake();
            }

            return result;
          }

          case 'run_respond': {
            const { operation: _operation, ...value } = request;

            return respondToRun(value, runDependencies, signal);
          }

          case 'run_resume': {
            const { operation: _operation, ...value } = request;

            return resumeRun(value, runDependencies, signal);
          }

          case 'run_cancel': {
            const { operation: _operation, ...value } = request;
            const queued = opened.workerQueue.read(value.jobId);

            if (queued.outcome === 'rejected') {
              return queued;
            }

            if (queued.value && !queued.value.jobId) {
              const cancelled = opened.workerQueue.cancel(value.jobId);

              return cancelled.outcome === 'persisted'
                ? { ...cancelled, value: workerQueueReceipt(cancelled.value) }
                : cancelled;
            }

            if (queued.value?.jobId) {
              value.jobId = queued.value.jobId;
            }

            const result = await cancelRun(value, runDependencies, signal);

            if (result.outcome === 'persisted') {
              coordinator.wake();
            }

            return result;
          }

          case 'status':
            return coordinator.status();
          case 'stop':
            return completed({ stopping: true as const });
          case 'wake':
            coordinator.wake();
            cleanupExecutor?.wake();

            return coordinator.status();
          case 'inspect':
            return inspectServiceJob({ schemaVersion: 1, jobId: request.jobId }, opened.service);
          case 'cleanup_inspect': {
            const { operation: _operation, ...input } = request;

            return inspectCleanup(input, cleanupDependencies);
          }

          case 'cleanup_request': {
            const { operation: _operation, ...input } = request;
            let result = requestCleanup(input, cleanupDependencies);

            if (
              !cleanupExecutor &&
              result.outcome === 'persisted' &&
              result.value.request.automatic &&
              ['requested', 'blocked'].includes(result.value.phase)
            ) {
              result = controlCleanup(
                {
                  schemaVersion: 1,
                  jobId: result.value.request.jobId,
                  expectedRevision: result.value.revision,
                  action: 'suspend',
                },
                cleanupDependencies,
              );
            }

            if (result.outcome === 'persisted') {
              cleanupExecutor?.wake();
            }

            return result;
          }

          case 'cleanup_control': {
            const { operation: _operation, ...input } = request;

            if (!cleanupExecutor && input.action === 'resume') {
              const plan = opened.cleanups.read(input.jobId);

              if (plan.outcome === 'rejected') {
                return plan;
              }

              if (plan.value?.request.automatic) {
                return rejected(
                  'cleanup_blocked',
                  'Start the service with --cleanup before resuming automatic plans.',
                );
              }
            }

            const result = controlCleanup(input, cleanupDependencies);

            if (result.outcome === 'persisted') {
              cleanupExecutor?.wake();
            }

            return result;
          }

          case 'submit': {
            const { operation: _operation, ...submission } = request;
            const result = await submitServiceJob(submission, dependencies);

            if (result.outcome === 'persisted') {
              coordinator.wake();
            }

            return result;
          }
        }
      },
    });

    function close(): Promise<OperationResult<{ closed: true }>> {
      if (!closing) {
        closing = (async () => {
          let result: OperationResult<{ closed: true }> = completed({ closed: true });

          try {
            for (const stop of eventWatches.values()) {
              stop();
            }

            eventWatches.clear();
            const drained = await Promise.allSettled([
              transport.close(),
              coordinator.stop(),
              cleanupExecutor?.stop(),
            ]);

            if (drained.some((result) => result.status === 'rejected')) {
              fatal = true;
            }
          } catch {
            fatal = true;
          } finally {
            const stateClosed = stateStore.close();
            ownership?.release();

            if (stateClosed.outcome === 'rejected' || fatal) {
              result = rejected(
                'service_unavailable',
                'Service stopped after an uncertain failure; inspect saved effects before retrying.',
              );
            }
          }

          resolveClosed(result);

          return result;
        })();
      }

      return closing;
    }

    coordinator.start();
    cleanupExecutor?.start();

    return {
      schemaVersion: 1 as const,
      outcome: 'listening' as const,
      sessionId,
      stateDirectory: opened.stateDirectory,
      socketPath: transport.path,
      status: () => coordinator.status(),
      close,
      closed,
    };
  } catch (error) {
    ownership?.release();
    closeState();

    if (hasFileCode(error, 'EPERM') || hasFileCode(error, 'EACCES')) {
      return rejected(
        'service_unavailable',
        'Local service could not bind its socket; check host permissions and use a short private state path.',
      );
    }

    const result = stateRejection(error);

    return result.error.code === 'state_unavailable'
      ? rejected(
          'service_endpoint_unsafe',
          'Service could not own its endpoint. Use a short private state path; preserve unowned endpoint files.',
        )
      : result;
  }
}
