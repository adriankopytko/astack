import { requestCleanup, controlCleanup, inspectCleanup } from '../application/cleanup.js';
import { createCleanupExecutor, suspendCleanupExecutor } from '../application/automatic-cleanup.js';
import { composeCleanupDependencies } from './cleanup.js';
import {
  inspectReviewAutomation,
  configureReviewAutomation,
  enqueueFollowUpReview,
  inspectFollowUpReview,
  listFollowUpReviews,
  controlFollowUpReview,
  createFollowUpDispatcher,
  suspendFollowUpExecutor,
  type AutomaticReviewDependencies,
} from '../application/automatic-review.js';
import {
  watchCi,
  controlCi,
  inspectCi,
  listCi,
  createCiObserver,
  type CiDependencies,
} from '../application/ci.js';
import { ciPolicySchema } from '../contracts/ci.js';
import type { CiReader } from '../ports/ci.js';
import { createGhCiReader } from '../adapters/github/ci-reader.js';
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
import {
  submitImplementation,
  inspectImplementation,
  type ImplementationDependencies,
} from '../application/implementation.js';
import { createNodeWorktreeFiles } from '../adapters/filesystem/worktree-files.js';
import { nodeImplementationContextReader } from '../adapters/filesystem/implementation-context.js';
import { submitReview, inspectReview, type ReviewDependencies } from '../application/review.js';
import { createGhReviewTargetReader } from '../adapters/github/review-target.js';
import type { ReviewTargetReader } from '../ports/review.js';
import { composeCodexHerdrRuntime } from './codex-runtime.js';
import { listenLocalService } from '../service/local-transport.js';
import type { CoordinatorOwnership, ServiceWorkerRuntime } from '../ports/service.js';

/** Explicit composition boundary shared by the CLI and library hosts; construction imports do no IO. */
export async function startLocalService(
  input: unknown,
  options: {
    runtimes?: readonly ServiceWorkerRuntime[];
    ci?: { policy?: unknown; reader?: CiReader };
    afterHandoffReview?: boolean;
    cleanup?: boolean;
    cleanupHerdrExecutable?: string;
    cleanupShutdown?: RunShutdownVerifier;
    reviewTargets?: ReviewTargetReader;
    githubExecutable?: string;
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

  if (options.afterHandoffReview && !options.ci) {
    return rejected('invalid_request', 'After-handoff review requires the CI observer opt-in.');
  }

  const ciPolicy = ciPolicySchema.safeParse(options.ci?.policy ?? {});

  if (!ciPolicy.success) {
    return rejected('invalid_request', 'Invalid CI observer policy.');
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
      ...(options.afterHandoffReview ? { automaticReviews: opened.automaticReviews } : {}),
      git: createGitInspector({ executable, runner: nodeProcessRunner }),
      identity: nodeCheckoutIdentityReader,
      configuration: createNodeConfigurationReader(opened.stateDirectory),
      prerequisites: createNodeConfigurationProbe(
        (name) => Object.hasOwn(process.env, name) && Boolean(process.env[name]),
      ),
      now: Date.now,
      nextId: (kind) => `${kind}-${randomUUID()}`,
    };
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

    const implementationDependencies: ImplementationDependencies = {
      ...dependencies,
      runs: opened.runs,
      worktrees: opened.worktrees,
      files: createNodeWorktreeFiles(join(opened.stateDirectory, 'worktrees')),
      instructions: nodeImplementationContextReader,
    };
    const gh = await hostExecutable('gh', options.githubExecutable);

    if (options.ci && !options.ci.reader && !gh) {
      ownership.release();
      opened.store.close();

      return rejected(
        'github_unavailable',
        'Select a trusted GitHub CLI executable before enabling CI observation.',
      );
    }

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

    const reviewDependencies: ReviewDependencies = {
      ...implementationDependencies,
      targets:
        options.reviewTargets ??
        (gh
          ? createGhReviewTargetReader({
              executable: gh,
              runner: nodeProcessRunner,
              environment,
              now: Date.now,
            })
          : {
              read: async () =>
                rejected(
                  'github_unavailable',
                  'Install or select a trusted GitHub CLI executable.',
                ),
            }),
    };
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

      const codexRuntime = composeCodexHerdrRuntime({
        opened,
        dependencies,
        reviewDependencies,
        herdrExecutable: herdr,
        codexExecutable: codex,
        allowAutomaticReview: options.afterHandoffReview ?? false,
      });
      runtimes.push(codexRuntime.runtime);
      workerInput = options.runWorkerInput ?? codexRuntime.workerInput;
      workerControl = options.runWorkerControl ?? codexRuntime.workerControl;
    }

    const runDependencies: RunDependencies = {
      ...reviewDependencies,
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
    const coordinator = createServiceCoordinator({
      sessionId,
      limits: request.value.limits,
      runtimes,
      dependencies,
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
    const ciDependencies: CiDependencies = {
      ...dependencies,
      ci: opened.ci,
      ...(options.afterHandoffReview ? { automaticCi: opened.automaticReviews } : {}),
      handoffs: opened.handoffs,
      runs: opened.runs,
      nextId: () => `ci-controller-${randomUUID()}`,
      random: Math.random,
      reader:
        options.ci?.reader ??
        (gh
          ? createGhCiReader({
              executable: gh,
              runner: nodeProcessRunner,
              environment,
              now: Date.now,
              timeoutMs: 30000,
            })
          : {
              read: async () =>
                rejected('github_unavailable', 'Select a trusted GitHub CLI executable.'),
            }),
    };
    const automaticDependencies: AutomaticReviewDependencies = {
      executorEnabled: options.afterHandoffReview ?? false,
      store: opened.automaticReviews,
      reviews: reviewDependencies,
      ci: ciDependencies,
      now: Date.now,
      wake: () => coordinator.wake(),
      wakeCi: () => ciObserver?.wake(),
    };
    let ciObserver: ReturnType<typeof createCiObserver> | null = null;
    const automaticDispatcher = options.afterHandoffReview
      ? createFollowUpDispatcher(automaticDependencies, () => {
          fatal = true;
          void close();
        })
      : null;
    ciObserver = options.ci
      ? createCiObserver(
          ciDependencies,
          ciPolicy.data,
          () => {
            fatal = true;
            void close();
          },
          () => automaticDispatcher?.wake(),
        )
      : null;

    if (!options.afterHandoffReview) {
      const suspended = await suspendFollowUpExecutor(opened.automaticReviews, Date.now);

      if (suspended.outcome !== 'completed') {
        opened.store.close();
        ownership.release();

        return suspended;
      }
    }

    const transport = await listenLocalService({
      stateDirectory: opened.stateDirectory,
      sessionId,
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
          case 'review_automation_inspect': {
            const { operation: _operation, ...value } = request;

            return inspectReviewAutomation(value, automaticDependencies);
          }

          case 'review_automation_configure': {
            const { operation: _operation, ...value } = request;
            const result = await configureReviewAutomation(value, automaticDependencies, signal);
            automaticDispatcher?.wake();
            cleanupExecutor?.wake();
            ciObserver?.wake();

            return result;
          }

          case 'follow_up_inspect': {
            const { operation: _operation, ...value } = request;

            return inspectFollowUpReview(value, automaticDependencies);
          }

          case 'follow_up_list': {
            const { operation: _operation, ...value } = request;

            return listFollowUpReviews(value, automaticDependencies);
          }

          case 'follow_up_enqueue': {
            const { operation: _operation, ...value } = request;
            const result = await enqueueFollowUpReview(value, automaticDependencies, signal);

            if (result.outcome === 'persisted') {
              automaticDispatcher?.wake();
              cleanupExecutor?.wake();
            }

            return result;
          }

          case 'follow_up_control': {
            const { operation: _operation, ...value } = request;
            const result = await controlFollowUpReview(value, automaticDependencies, signal);

            if (result.outcome === 'persisted') {
              automaticDispatcher?.wake();
              cleanupExecutor?.wake();
              ciObserver?.wake();
              coordinator.wake();
            }

            return result;
          }

          case 'ci_inspect': {
            const { operation: _operation, ...value } = request;

            return inspectCi(value, ciDependencies);
          }

          case 'ci_list': {
            const { operation: _operation, ...value } = request;

            return listCi(value, ciDependencies);
          }

          case 'ci_watch': {
            const { operation: _operation, ...value } = request;
            const result = await watchCi(value, ciDependencies, signal);

            if (result.outcome === 'persisted') {
              ciObserver?.wake();
            }

            return result;
          }

          case 'ci_control': {
            const { operation: _operation, ...value } = request;
            const result = await controlCi(value, ciDependencies, signal);

            if (result.outcome === 'persisted') {
              ciObserver?.wake();
            }

            return result;
          }

          case 'ci_wake': {
            if (!ciObserver) {
              return rejected(
                'ci_blocked',
                'CI observation is disabled; restart the service with explicit CI opt-in.',
              );
            }

            ciObserver.wake();

            return completed({ scheduled: true as const });
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

            return acceptRunReport(value, runDependencies, signal);
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

            return cancelRun(value, runDependencies, signal);
          }

          case 'status':
            return coordinator.status();
          case 'wake':
            coordinator.wake();
            automaticDispatcher?.wake();
            cleanupExecutor?.wake();

            return coordinator.status();
          case 'inspect':
            return inspectServiceJob({ schemaVersion: 1, jobId: request.jobId }, opened.service);
          case 'review_inspect':
            return inspectReview({ schemaVersion: 1, jobId: request.jobId }, reviewDependencies);
          case 'review_submit': {
            const { operation: _operation, ...submission } = request;
            const result = await submitReview(submission, reviewDependencies);

            if (result.outcome === 'persisted') {
              coordinator.wake();
            }

            return result;
          }

          case 'implement_inspect':
            return inspectImplementation(
              { schemaVersion: 1, jobId: request.jobId },
              implementationDependencies,
            );
          case 'implement_submit': {
            const { operation: _operation, ...submission } = request;
            const result = await submitImplementation(submission, implementationDependencies);

            if (result.outcome === 'persisted') {
              coordinator.wake();
            }

            return result;
          }

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
            const drained = await Promise.allSettled([
              transport.close(),
              coordinator.stop(),
              ciObserver?.stop(),
              automaticDispatcher?.stop(),
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
    ciObserver?.start();
    automaticDispatcher?.start();
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
