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
    reviewTargets?: ReviewTargetReader;
    githubExecutable?: string;
    codexHerdr?: { herdrExecutable?: string; codexExecutable?: string };
  } = {},
) {
  const request = parseOperationRequest(serviceRunRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const opened = await openSqliteState({
    schemaVersion: 1,
    ...(request.value.stateDirectory === undefined
      ? {}
      : { stateDirectory: request.value.stateDirectory }),
  });

  if (opened.outcome !== 'opened') {
    return opened;
  }

  let ownership: CoordinatorOwnership | undefined;
  const stateStore = opened.store;

  try {
    ownership = await acquireCoordinatorOwnership(opened.stateDirectory);
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
      git: createGitInspector({ executable, runner: nodeProcessRunner }),
      identity: nodeCheckoutIdentityReader,
      configuration: createNodeConfigurationReader(opened.stateDirectory),
      prerequisites: createNodeConfigurationProbe(
        (name) => Object.hasOwn(process.env, name) && Boolean(process.env[name]),
      ),
      now: Date.now,
      nextId: (kind) => `${kind}-${randomUUID()}`,
    };
    const implementationDependencies: ImplementationDependencies = {
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

      runtimes.push(
        composeCodexHerdrRuntime({
          opened,
          dependencies,
          reviewDependencies,
          herdrExecutable: herdr,
          codexExecutable: codex,
        }),
      );
    }

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
    const transport = await listenLocalService({
      stateDirectory: opened.stateDirectory,
      sessionId,
      async handle(input): Promise<ServiceRpcResponse> {
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
          case 'status':
            return coordinator.status();
          case 'wake':
            coordinator.wake();

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
            const drained = await Promise.allSettled([transport.close(), coordinator.stop()]);

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
    opened.store.close();

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
