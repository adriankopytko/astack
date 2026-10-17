import {
  herdrConfigureRequestSchema,
  herdrProjectRequestSchema,
  herdrWorkerRequestSchema,
  herdrAgentRequestSchema,
  herdrReconcileRequestSchema,
  herdrSpaceSchema,
  herdrSettingsSchema,
  type HerdrResult,
  type HerdrSettings,
} from '../contracts/herdr.js';
import { rejected } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { sha256 } from '../core/file-paths.js';
import { selectProjectContext } from './select-project-context.js';
import { checkConfigurationDispatch } from './configuration.js';
import {
  HerdrFailure,
  read,
  persisted,
  same,
  result,
  perform,
  configured,
  project,
  matching,
  selectedHandle,
  observe,
  workerContext,
  type HerdrDependencies,
} from './herdr-evidence.js';
export type { HerdrDependencies } from './herdr-evidence.js';

export async function configureHerdrProject(
  input: unknown,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<HerdrSettings>> {
  const request = parseOperationRequest(herdrConfigureRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const selected = await selectProjectContext(
    { schemaVersion: 1, projectId: request.value.projectId },
    dependencies,
    signal,
  );

  if (selected.outcome === 'rejected') {
    return selected;
  }

  const { project, checkout, git } = selected.value;

  if (
    !project ||
    !checkout?.location ||
    git.checkout.gitDirectory !== git.repository.commonDirectory
  ) {
    return rejected(
      'herdr_unsupported',
      'Herdr primary grouping currently requires the registered main checkout.',
    );
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Herdr configuration was cancelled before persistence.');
  }

  return dependencies.herdr.configure(
    herdrSettingsSchema.parse({
      schemaVersion: 1,
      projectId: project.project.id,
      repositoryId: project.repository.id,
      primaryCheckoutId: checkout.checkout.id,
      root: checkout.checkout.rootPath,
      location: checkout.location,
      target: request.value.target,
      label: request.value.label ?? project.project.id,
    }),
  );
}

export async function ensureHerdrProject(
  input: unknown,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  return perform(herdrProjectRequestSchema, input, signal, async ({ projectId }) => {
    const config = configured(projectId, dependencies);
    await project(config, dependencies, signal);
    const snapshot = read(await dependencies.provider.snapshot(config.target, config.root, signal));
    let record = read(dependencies.herdr.primary(projectId));

    if (record?.phase === 'pending') {
      return result('pending', record, 'pending_writer');
    }

    const candidates = matching(snapshot, config.root, 'primary');

    if (candidates.length > 1) {
      return result('blocked', record, 'ambiguous');
    }

    const candidate = candidates[0];
    const handle = candidate
      ? selectedHandle(snapshot, candidate.id, config.root, record?.handle)
      : null;

    if (record && handle && same(record.server, snapshot.server) && same(record.handle, handle)) {
      return result('reused', record, null, observe(record, snapshot).observation);
    }

    const existingWorkspaceId = record?.handle?.workspaceId;

    if (
      record &&
      same(record.server, snapshot.server) &&
      snapshot.workspaces.some((workspace) => workspace.id === existingWorkspaceId) &&
      !candidate
    ) {
      return result('blocked', record, 'layout_changed');
    }

    const next = herdrSpaceSchema.parse(
      record
        ? {
            ...record,
            phase: 'pending',
            operationId: dependencies.newId(),
            revision: record.revision + 1,
            server: snapshot.server,
            handle: null,
          }
        : {
            schemaVersion: 1,
            id: dependencies.newId(),
            projectId,
            repositoryId: config.repositoryId,
            checkoutId: config.primaryCheckoutId,
            root: config.root,
            location: config.location,
            kind: 'primary',
            attemptId: null,
            branch: null,
            commit: null,
            target: config.target,
            server: snapshot.server,
            phase: 'pending',
            operationId: dependencies.newId(),
            revision: 0,
            label: config.label,
            primaryWorkspaceId: null,
            primaryRoot: null,
            expectedAgentName: null,
            handle: null,
            agent: null,
          },
    );
    const reserved = record
      ? dependencies.herdr.replacePrimary(record, next)
      : dependencies.herdr.reserve(next);

    if (reserved.outcome !== 'persisted') {
      throw new HerdrFailure(reserved);
    }

    const claimed = reserved.disposition === (record ? 'updated' : 'created');
    record = reserved.value;

    if (!claimed || !same(record, next)) {
      return result('pending', record, 'pending_writer');
    }

    try {
      if (!candidate) {
        if (signal?.aborted) {
          return result('pending', record, 'pending_writer');
        }

        const created = await dependencies.provider.createPrimary(
          {
            target: config.target,
            server: snapshot.server,
            root: config.root,
            label: config.label,
          },
          signal,
        );

        if (created.outcome === 'rejected') {
          return result('pending', record, 'provider_uncertain');
        }
      }

      const fresh = read(await dependencies.provider.snapshot(config.target, config.root));
      await project(config, dependencies);
      const evidence = observe(record, fresh);

      if (evidence.reason || !evidence.observation?.handle) {
        return result('pending', record, evidence.reason ?? 'layout_missing', evidence.observation);
      }

      const saved = persisted(
        dependencies.herdr.finish(record, {
          ...record,
          phase: 'ready',
          handle: evidence.observation.handle,
        }),
      );

      return result(candidate ? 'reused' : 'prepared', saved, null, evidence.observation);
    } catch (error) {
      return error instanceof HerdrFailure && error.result.outcome === 'uncertain'
        ? error.result
        : result('pending', record, 'provider_uncertain');
    }
  });
}

export async function prepareHerdrWorker(
  input: unknown,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  return perform(herdrWorkerRequestSchema, input, signal, async ({ attemptId }) => {
    const run = read(await dependencies.registry.readRun(attemptId));

    if (!run) {
      return rejected('run_not_found', 'A saved attempt is required for a worker space.');
    }

    const config = configured(run.projectId, dependencies);
    const job = read(
      dependencies.state.inspectRecord({ schemaVersion: 1, entity: 'job', id: run.jobId }),
    );

    if (job?.entity !== 'job') {
      return rejected('state_not_found', 'Worker job is missing.');
    }

    const policy = read(
      await checkConfigurationDispatch({ schemaVersion: 1, job: job.record }, dependencies, signal),
    );

    if (policy.status !== 'ready') {
      return rejected(
        'configuration_blocked',
        'Resolve the saved job configuration blockers before opening a worker space.',
      );
    }

    const previous = read(dependencies.herdr.worker(attemptId));

    if (previous) {
      await workerContext(previous, dependencies, signal);
      const snapshot = read(
        await dependencies.provider.snapshot(config.target, config.root, signal),
      );
      const evidence = observe(previous, snapshot);

      return result(
        previous.phase === 'pending' ? 'pending' : evidence.reason ? 'blocked' : 'reused',
        previous,
        previous.phase === 'pending' ? 'pending_writer' : evidence.reason,
        evidence.observation,
      );
    }

    const selected = read(
      await selectProjectContext({ schemaVersion: 1, runId: attemptId }, dependencies, signal),
    );
    const managed = read(dependencies.herdr.managedCheckout(run.checkoutId));

    if (
      !managed ||
      managed.phase !== 'ready' ||
      !selected.checkout?.location ||
      run.commit !== selected.git.checkout.head.commit ||
      run.branch !== selected.git.checkout.head.branch
    ) {
      return result('blocked', null, 'managed_checkout_required');
    }

    const primaryResult = await ensureHerdrProject(
      { schemaVersion: 1, projectId: run.projectId },
      dependencies,
      signal,
    );

    if (
      !('record' in primaryResult) ||
      !primaryResult.record?.handle ||
      !['prepared', 'reused'].includes(primaryResult.outcome)
    ) {
      return primaryResult;
    }

    const primary = primaryResult.record;

    if (!primary.handle) {
      return result('blocked', primary, 'layout_missing');
    }

    const snapshot = read(await dependencies.provider.snapshot(config.target, config.root, signal));

    if (matching(snapshot, selected.checkout.checkout.rootPath, 'worker').length) {
      return result('blocked', null, 'unowned_workspace');
    }

    const operationId = dependencies.newId();
    const record = herdrSpaceSchema.parse({
      schemaVersion: 1,
      id: dependencies.newId(),
      projectId: run.projectId,
      repositoryId: run.repositoryId,
      checkoutId: run.checkoutId,
      root: selected.checkout.checkout.rootPath,
      location: selected.checkout.location,
      kind: 'worker',
      attemptId,
      branch: run.branch,
      commit: run.commit,
      target: config.target,
      server: snapshot.server,
      phase: 'pending',
      operationId,
      revision: 0,
      label: `astack-${sha256(`${attemptId}:${operationId}`).slice(0, 24)}`,
      primaryWorkspaceId: primary.handle.workspaceId,
      primaryRoot: config.root,
      expectedAgentName: `astack-${sha256(`${run.projectId}:${attemptId}`).slice(0, 24)}`,
      handle: null,
      agent: null,
    });
    await workerContext(record, dependencies, signal);
    const reserved = dependencies.herdr.reserve(record);

    if (reserved.outcome !== 'persisted') {
      throw new HerdrFailure(reserved);
    }

    if (reserved.disposition !== 'created') {
      return result('pending', reserved.value, 'pending_writer');
    }

    if (signal?.aborted) {
      return result('pending', record, 'pending_writer');
    }

    try {
      const opened = await dependencies.provider.openWorker(
        {
          target: config.target,
          server: record.server,
          root: record.root,
          parent: record.primaryWorkspaceId ?? '',
          label: record.label,
        },
        signal,
      );

      if (opened.outcome === 'rejected' || opened.value.alreadyOpen) {
        return result('pending', record, 'provider_uncertain');
      }

      const fresh = read(await dependencies.provider.snapshot(config.target, config.root));
      const checked = await workerContext(record, dependencies);
      const evidence = observe(record, fresh);

      if (
        checked.git.checkout.head.branch !== record.branch ||
        checked.git.checkout.head.commit !== record.commit ||
        evidence.reason ||
        !evidence.observation?.handle
      ) {
        return result(
          'pending',
          record,
          evidence.reason ?? 'assignment_changed',
          evidence.observation,
        );
      }

      const saved = persisted(
        dependencies.herdr.finish(record, {
          ...record,
          phase: 'ready',
          handle: evidence.observation.handle,
        }),
      );

      return result('prepared', saved, null, evidence.observation);
    } catch (error) {
      return error instanceof HerdrFailure && error.result.outcome === 'uncertain'
        ? error.result
        : result('pending', record, 'provider_uncertain');
    }
  });
}

export async function inspectHerdrProject(
  input: unknown,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  return perform(herdrProjectRequestSchema, input, signal, async ({ projectId }) => {
    const config = configured(projectId, dependencies);
    await project(config, dependencies, signal);
    const record = read(dependencies.herdr.primary(projectId));
    const snapshot = read(await dependencies.provider.snapshot(config.target, config.root, signal));

    if (!record) {
      return result('inspected', null, 'layout_missing', {
        server: snapshot.server,
        handle: null,
        agent: null,
        agentStatus: null,
      });
    }

    const evidence = observe(record, snapshot);

    return result(
      record.phase === 'pending' ? 'pending' : evidence.reason ? 'blocked' : 'inspected',
      record,
      record.phase === 'pending' ? 'pending_writer' : evidence.reason,
      evidence.observation,
    );
  });
}

export async function inspectHerdrWorker(
  input: unknown,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  return perform(herdrWorkerRequestSchema, input, signal, async ({ attemptId }) => {
    const record = read(dependencies.herdr.worker(attemptId));

    if (!record) {
      return result('blocked', null, 'layout_missing');
    }

    await project(configured(record.projectId, dependencies), dependencies, signal);
    await workerContext(record, dependencies, signal);
    const snapshot = read(await dependencies.provider.snapshot(record.target, record.root, signal));
    const evidence = observe(record, snapshot);

    return result(
      record.phase === 'pending' ? 'pending' : evidence.reason ? 'blocked' : 'inspected',
      record,
      record.phase === 'pending' ? 'pending_writer' : evidence.reason,
      evidence.observation,
    );
  });
}

export async function bindHerdrAgent(
  input: unknown,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  return perform(herdrAgentRequestSchema, input, signal, async ({ attemptId, kind }) => {
    const inspected = await inspectHerdrWorker(
      { schemaVersion: 1, attemptId },
      dependencies,
      signal,
    );

    if (!('record' in inspected) || !inspected.record || inspected.outcome !== 'inspected') {
      return inspected;
    }

    const record = inspected.record;
    const agent = inspected.observation?.agent;

    if (record.phase !== 'ready' || !agent || agent.kind !== kind) {
      return result('blocked', record, 'agent_mismatch', inspected.observation);
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Agent binding was cancelled before persistence.');
    }

    return result(
      'reconciled',
      persisted(dependencies.herdr.bindAgent(record, agent)),
      null,
      inspected.observation,
    );
  });
}

export async function reconcileHerdrSpace(
  input: unknown,
  dependencies: HerdrDependencies,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  return perform(herdrReconcileRequestSchema, input, signal, async ({ id, operationId }) => {
    const record = read(dependencies.herdr.read(id));

    if (!record || record.operationId !== operationId) {
      return rejected('herdr_conflict', 'Select the exact saved space and pending operation ID.');
    }

    await project(configured(record.projectId, dependencies), dependencies, signal);

    if (record.kind === 'worker') {
      await workerContext(record, dependencies, signal);
    }

    const snapshot = read(await dependencies.provider.snapshot(record.target, record.root, signal));
    const evidence = observe(record, snapshot);
    const workspace = snapshot.workspaces.find(
      (item) => item.id === evidence.observation?.handle?.workspaceId,
    );

    if (
      evidence.reason ||
      !evidence.observation?.handle ||
      (record.kind === 'worker' && record.phase === 'pending' && workspace?.label !== record.label)
    ) {
      return result(
        'blocked',
        record,
        evidence.reason ?? 'unowned_workspace',
        evidence.observation,
      );
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Space reconciliation was cancelled before persistence.');
    }

    const saved =
      record.phase === 'ready'
        ? record
        : persisted(
            dependencies.herdr.finish(record, {
              ...record,
              phase: 'ready',
              handle: evidence.observation.handle,
            }),
          );

    return result('reconciled', saved, null, evidence.observation);
  });
}
