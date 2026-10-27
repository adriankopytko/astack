import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  initializationRequestSchema,
  type InitializationResult,
  type InitializationView,
  type InitializationRequest,
} from '../contracts/initialization.js';
import { rejected, type OperationResult } from '../contracts/operation-result.js';
import type { CheckoutLocation, ProjectSelection } from '../contracts/projects.js';
import type { ManagedFileStore } from '../ports/managed-file-store.js';
import type { InitializationFiles } from '../ports/initialization.js';
import type { WorktreeStore } from '../ports/worktrees.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { locateCheckout } from './project-facts.js';
import { selectProjectContext } from './select-project-context.js';
import { registerProject, type ProjectRegistrationDependencies } from './register-project.js';
import { resolveConfiguration, type ConfigurationDependencies } from './configuration.js';
import { inspectSkills, installSkills, type SkillsDependencies } from './skills.js';
import { configureHerdrProject, ensureHerdrProject, type HerdrDependencies } from './herdr.js';
import {
  preserveEstablishedProposal,
  initializationAssets,
  inspectInitializationAsset,
  writeInitializationAsset,
  initializationDiagnostic as diagnostic,
} from './initialization-plan.js';
export interface InitializationDependencies
  extends ProjectRegistrationDependencies, ConfigurationDependencies {
  files: ManagedFileStore;
  layout: InitializationFiles;
  skills: SkillsDependencies;
  userSkillsRoot: string;
  hostRoot: string;
  herdr?: HerdrDependencies;
  worktrees?: WorktreeStore;
}
function selectionRequest(request: InitializationRequest) {
  return {
    schemaVersion: 1,
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.checkoutId === undefined ? {} : { checkoutId: request.checkoutId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(request.callerDirectory === undefined ? {} : { callerDirectory: request.callerDirectory }),
  };
}

async function select(
  request: InitializationRequest,
  deps: InitializationDependencies,
  signal?: AbortSignal,
): Promise<OperationResult<ProjectSelection>> {
  const result = await selectProjectContext(selectionRequest(request), deps, signal);

  if (result.outcome === 'rejected') {
    return result;
  }

  const selected = result.value;

  if (
    request.assignProjectId !== undefined &&
    selected.project?.project.id !== request.assignProjectId
  ) {
    const collision = await deps.registry.readProject(request.assignProjectId);

    if (collision.outcome === 'rejected') {
      return collision;
    }

    if (selected.project || collision.value) {
      return rejected(
        'project_registration_conflict',
        'The assigned project ID conflicts with a saved repository.',
      );
    }
  }

  if (
    selected.project?.registeredAt == null &&
    selected.git.checkout.gitDirectory !== selected.git.repository.commonDirectory
  ) {
    return rejected(
      'project_registration_conflict',
      'Register the primary checkout explicitly before initializing a linked checkout.',
    );
  }

  if (selected.checkout && deps.worktrees) {
    const owned = deps.worktrees.forCheckout(selected.checkout.checkout.id);

    if (owned.outcome === 'rejected') {
      return owned;
    }

    if (owned.value) {
      return rejected(
        'worktree_conflict',
        'Initialize the primary or a deliberate linked checkout, not an Astack-managed task checkout.',
      );
    }
  }

  return result;
}

function target(
  selected: ProjectSelection,
  location: CheckoutLocation = selected.checkout!.location!,
): InitializationView['target'] {
  return {
    root: selected.git.checkout.rootPath,
    location,
    branch: selected.git.checkout.head.branch,
    commit: selected.git.checkout.head.commit,
    linked: selected.git.checkout.gitDirectory !== selected.git.repository.commonDirectory,
    projectId: selected.project?.project.id ?? null,
    repositoryId: selected.project?.repository.id ?? null,
    checkoutId: selected.checkout?.checkout.id ?? null,
  };
}

async function sameTarget(
  selected: ProjectSelection,
  deps: InitializationDependencies,
  signal?: AbortSignal,
  location = selected.checkout?.location,
) {
  const fresh = await selectProjectContext(
    { schemaVersion: 1, path: selected.git.checkout.rootPath },
    deps,
    signal,
  );

  if (fresh.outcome === 'rejected') {
    return fresh;
  }

  const observedLocation = await locateCheckout(fresh.value.git, deps, signal);

  if (location && !isDeepStrictEqual(observedLocation, location)) {
    return rejected('project_checkout_stale', 'Initialization checkout identity changed.');
  }

  if (
    fresh.value.git.checkout.rootPath !== selected.git.checkout.rootPath ||
    fresh.value.git.repository.commonDirectory !== selected.git.repository.commonDirectory ||
    fresh.value.git.checkout.gitDirectory !== selected.git.checkout.gitDirectory ||
    !isDeepStrictEqual(fresh.value.git.checkout.head, selected.git.checkout.head) ||
    (selected.checkout?.location &&
      !isDeepStrictEqual(fresh.value.checkout?.location, selected.checkout.location))
  ) {
    return rejected(
      'project_checkout_stale',
      'Initialization target identity or branch/HEAD changed.',
    );
  }

  return fresh;
}

async function readiness(
  view: InitializationView,
  deps: InitializationDependencies,
  signal?: AbortSignal,
) {
  view.configuration = [];

  if (view.target.projectId && view.target.checkoutId) {
    for (const role of ['implementer', 'reviewer'] as const) {
      view.configuration.push({
        role,
        result: await resolveConfiguration(
          {
            schemaVersion: 1,
            projectId: view.target.projectId,
            checkoutId: view.target.checkoutId,
            role,
          },
          deps,
          signal,
        ),
      });
    }
  }

  const policyReady =
    view.configuration.length === 2 &&
    view.configuration.every(
      (item) => item.result.outcome === 'completed' && item.result.value.status === 'ready',
    );
  const hooksRequested = view.configuration.some(
    (item) =>
      item.result.outcome === 'completed' &&
      item.result.value.snapshot &&
      Object.values(item.result.value.snapshot.effective.hooks).some((hook) => hook !== null),
  );
  view.delegation =
    policyReady && view.provider.status === 'ready' && !hooksRequested
      ? 'requires_owned_checkout'
      : 'not_ready';

  if (!policyReady) {
    diagnostic(
      view,
      'execution_policy_required',
      'Review private host policy and prerequisites explicitly; registration and project proposals do not authorize execution.',
    );
  }

  if (hooksRequested) {
    diagnostic(
      view,
      'hooks_not_implemented',
      'Lifecycle hook execution remains unavailable; declared scripts are suggestions only.',
    );
  }

  diagnostic(
    view,
    'owned_task_checkout_required',
    'Delegation still needs an explicit ready owned task checkout and accepted assignment.',
  );
}

async function provider(
  view: InitializationView,
  request: InitializationRequest,
  deps: InitializationDependencies,
  signal?: AbortSignal,
) {
  if (!request.herdr) {
    return;
  }

  if (!deps.herdr || !view.target.projectId) {
    view.provider.status = 'blocked';
    diagnostic(
      view,
      'herdr_unavailable',
      'Select a registered project and trusted Herdr provider.',
    );

    return;
  }

  const stored = deps.herdr.herdr.settings(view.target.projectId);

  if (stored.outcome === 'rejected') {
    view.provider.status = 'blocked';
    diagnostic(view, stored.error.code, stored.error.message);

    return;
  }

  view.provider.settings = stored.value;

  if (
    stored.value &&
    ((request.herdr.target && !isDeepStrictEqual(stored.value.target, request.herdr.target)) ||
      (request.herdr.label && request.herdr.label !== stored.value.label))
  ) {
    view.provider.status = 'blocked';
    diagnostic(
      view,
      'herdr_target_conflict',
      'Preserve existing project Herdr settings; use explicit Herdr configuration to change them.',
    );

    return;
  }

  if (!stored.value) {
    if (!request.herdr.target) {
      view.provider.status = 'blocked';
      diagnostic(
        view,
        'herdr_target_required',
        'Supply an explicit Herdr session/socket or configure the project target first.',
      );

      return;
    }

    const configured = await configureHerdrProject(
      {
        schemaVersion: 1,
        projectId: view.target.projectId,
        target: request.herdr.target,
        ...(request.herdr.label === undefined ? {} : { label: request.herdr.label }),
      },
      deps.herdr,
      signal,
    );

    if (configured.outcome !== 'persisted') {
      view.provider.status = configured.outcome === 'uncertain' ? 'pending' : 'blocked';
      diagnostic(
        view,
        'herdr_configuration_unavailable',
        'Herdr settings were not confirmed; inspect saved project settings before retry.',
      );

      return;
    }

    view.provider.settings = configured.value;
  }

  const result = await ensureHerdrProject(
    { schemaVersion: 1, projectId: view.target.projectId },
    deps.herdr,
    signal,
  );
  view.provider.result = result;
  view.provider.status =
    'record' in result && result.record?.phase === 'ready' && !result.reason
      ? 'ready'
      : result.outcome === 'pending' || result.outcome === 'uncertain'
        ? 'pending'
        : 'blocked';
}

/** Host holds coordinator ownership throughout apply. Preview performs no registry/file/provider mutation. */
export async function initializeProject(
  input: unknown,
  deps: InitializationDependencies,
  signal?: AbortSignal,
): Promise<InitializationResult> {
  const parsed = parseOperationRequest(initializationRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Initialization was cancelled before setup.');
  }

  const request = parsed.value;
  let view: InitializationView | null = null;
  let registration: Extract<InitializationResult, { view: unknown }>['registration'] = null;

  try {
    const chosen = await select(request, deps, signal);

    if (chosen.outcome === 'rejected') {
      return chosen;
    }

    let selected = chosen.value;
    const signals = await deps.layout.signals(selected.git.checkout.rootPath);

    if (signals.outcome === 'rejected') {
      return signals;
    }

    const location = await locateCheckout(selected.git, deps, signal);
    const projectSkillsRoot = join(selected.git.checkout.rootPath, '.agents', 'skills');
    const projectSkillsDirectory = request.skills.length
      ? await deps.layout.directory(projectSkillsRoot, false, selected.git.checkout.rootPath)
      : null;

    view = {
      target: target(selected, location),
      registration: selected.registration === 'registered' ? 'registered' : 'required',
      signals: signals.value,
      assets: [],
      userSkills: await inspectSkills(
        { schemaVersion: 1, root: deps.userSkillsRoot, skills: ['orchestrator'] },
        deps.skills,
      ),
      projectSkills: request.skills.length
        ? projectSkillsDirectory?.outcome === 'rejected'
          ? projectSkillsDirectory
          : await inspectSkills(
              {
                schemaVersion: 1,
                root: join(selected.git.checkout.rootPath, '.agents', 'skills'),
                skills: request.skills,
                mode: 0o644,
              },
              deps.skills,
            )
        : null,
      provider: {
        status: request.herdr ? 'planned' : 'not_selected',
        settings: null,
        result: null,
      },
      configuration: [],
      delegation: 'not_ready',
      diagnostics: [],
    };
    view.target.location = location;

    if (deps.herdr && selected.project) {
      const settings = deps.herdr.herdr.settings(selected.project.project.id);

      if (settings.outcome === 'completed') {
        view.provider.settings = settings.value;
      }
    }

    for (const plan of initializationAssets(selected, deps.hostRoot, request.skills.length > 0)) {
      view.assets.push(await inspectInitializationAsset(plan, deps));
    }

    preserveEstablishedProposal(view.assets);

    if (request.preview) {
      await readiness(view, deps, signal);

      return { schemaVersion: 1, outcome: 'previewed', view, registration };
    }

    if (
      view.assets.some((asset) => ['pending', 'blocked'].includes(asset.state)) ||
      (view.projectSkills?.outcome === 'completed' &&
        view.projectSkills.value.skills.some((skill) => skill.state === 'pending'))
    ) {
      diagnostic(
        view,
        'initialization_blocked',
        'Preserve unsafe or pending setup and resolve its exact writer before continuing.',
      );

      return { schemaVersion: 1, outcome: 'partial', view, registration };
    }

    const checked = await sameTarget(selected, deps, signal, location);

    if (checked.outcome === 'rejected') {
      return checked;
    }

    registration = await registerProject(
      {
        schemaVersion: 1,
        path: selected.git.checkout.rootPath,
        ...(request.assignProjectId === undefined ? {} : { projectId: request.assignProjectId }),
      },
      deps,
      signal,
    );

    if (registration.outcome !== 'persisted') {
      view.registration = registration.outcome === 'uncertain' ? 'uncertain' : 'required';

      return { schemaVersion: 1, outcome: 'partial', view, registration };
    }

    const afterRegistration = await sameTarget(selected, deps, signal, location);

    if (afterRegistration.outcome === 'rejected') {
      diagnostic(view, afterRegistration.error.code, afterRegistration.error.message);

      return { schemaVersion: 1, outcome: 'partial', view, registration };
    }

    const registered = await selectProjectContext(
      {
        schemaVersion: 1,
        path: selected.git.checkout.rootPath,
        projectId: registration.value.project.id,
      },
      deps,
      signal,
    );

    if (registered.outcome === 'rejected') {
      diagnostic(view, registered.error.code, registered.error.message);

      return { schemaVersion: 1, outcome: 'partial', view, registration };
    }

    selected = registered.value;
    view.target = target(selected);
    view.registration = registration.disposition === 'created' ? 'created' : 'registered';
    const plans = initializationAssets(selected, deps.hostRoot, request.skills.length > 0);
    view.assets = [];

    for (const plan of plans) {
      view.assets.push(await inspectInitializationAsset(plan, deps));
    }

    preserveEstablishedProposal(view.assets);

    if (view.assets.some((asset) => ['pending', 'blocked'].includes(asset.state))) {
      diagnostic(
        view,
        'initialization_blocked',
        'Preserve unsafe or pending setup before new file effects.',
      );

      return { schemaVersion: 1, outcome: 'partial', view, registration };
    }

    for (const [root, paths] of [
      [
        view.target.root,
        ['.astack', ...(request.skills.length ? ['.agents', '.agents/skills'] : [])],
      ],
      [deps.hostRoot, ['config']],
    ] as const) {
      const ready = await sameTarget(selected, deps, signal);

      if (ready.outcome === 'rejected') {
        diagnostic(view, ready.error.code, ready.error.message);

        return { schemaVersion: 1, outcome: 'partial', view, registration };
      }

      const prepared = await deps.layout.prepare(root, paths, signal);

      if (prepared.outcome === 'rejected') {
        diagnostic(view, prepared.error.code, prepared.error.message);

        return { schemaVersion: 1, outcome: 'partial', view, registration };
      }
    }

    for (const [index, plan] of plans.entries()) {
      const ready = await sameTarget(selected, deps, signal);

      if (ready.outcome === 'rejected') {
        diagnostic(view, ready.error.code, ready.error.message);

        return { schemaVersion: 1, outcome: 'partial', view, registration };
      }

      const asset =
        view.assets[index]?.reason === 'existing_host_setup'
          ? view.assets[index]!
          : await writeInitializationAsset(plan, deps, signal);
      view.assets[index] = asset;

      if (asset.state === 'preserved') {
        diagnostic(
          view,
          `preserved_${asset.kind}`,
          asset.kind.endsWith('ignore')
            ? 'Authored ignore rules were preserved; ensure pending journals and stages stay out of commits.'
            : 'Authored or edited setup was preserved; compare the proposal and host policy deliberately.',
        );
      }

      if (['blocked', 'pending'].includes(asset.state)) {
        await readiness(view, deps);

        return { schemaVersion: 1, outcome: 'partial', view, registration };
      }
    }

    if (request.skills.length) {
      const ready = await sameTarget(selected, deps, signal);

      if (ready.outcome === 'rejected') {
        diagnostic(view, ready.error.code, ready.error.message);

        return { schemaVersion: 1, outcome: 'partial', view, registration };
      }

      view.projectSkills = await installSkills(
        {
          schemaVersion: 1,
          root: join(view.target.root, '.agents', 'skills'),
          skills: request.skills,
          mode: 0o644,
        },
        deps.skills,
        signal,
      );

      if (!['installed', 'unchanged'].includes(view.projectSkills.outcome)) {
        await readiness(view, deps);

        return { schemaVersion: 1, outcome: 'partial', view, registration };
      }
    }

    const beforeProvider = await sameTarget(selected, deps, signal);

    if (beforeProvider.outcome === 'rejected') {
      diagnostic(view, beforeProvider.error.code, beforeProvider.error.message);

      return { schemaVersion: 1, outcome: 'partial', view, registration };
    }

    await provider(view, request, deps, signal);
    await readiness(view, deps, signal);

    return {
      schemaVersion: 1,
      outcome: ['blocked', 'pending'].includes(view.provider.status) ? 'partial' : 'initialized',
      view,
      registration,
    };
  } catch {
    if (view) {
      diagnostic(
        view,
        'initialization_uncertain',
        'Initialization stopped; inspect successful stages and any pending writer before retry.',
      );

      return { schemaVersion: 1, outcome: 'partial', view, registration };
    }

    return rejected(
      'initialization_unavailable',
      'Initialization prerequisites could not be inspected.',
    );
  }
}
