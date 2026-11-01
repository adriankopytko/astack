import { join } from 'node:path';
import {
  initializationIgnore,
  initializationJson,
  initializationProjectConfig,
  initializationAssetVersion,
} from '../core/initialization-assets.js';
import type { ManagedFileStore } from '../ports/managed-file-store.js';
import type { InitializationFiles } from '../ports/initialization.js';
import type { InitializationAsset, InitializationView } from '../contracts/initialization.js';
import type { ProjectSelection } from '../contracts/projects.js';
import { inspectManagedFile, writeManagedFile } from './managed-files.js';
import { sha256 } from '../core/file-paths.js';
export interface InitializationAssetPlan {
  kind: InitializationAsset['kind'];
  root: string;
  anchor: string;
  path: string;
  content: string;
  owner: string;
  mode: 0o644;
}
export function initializationAssets(
  selection: ProjectSelection,
  skills: boolean,
): InitializationAssetPlan[] {
  const projectRoot = join(selection.git.checkout.rootPath, '.astack');

  return [
    {
      kind: 'project-ignore',
      root: projectRoot,
      anchor: selection.git.checkout.rootPath,
      path: '.gitignore',
      content: initializationIgnore,
      owner: 'astack:init:ignore',
      mode: 0o644,
    },
    {
      kind: 'project-config',
      root: projectRoot,
      anchor: selection.git.checkout.rootPath,
      path: 'config.json',
      content: initializationJson(initializationProjectConfig),
      owner: 'astack:init:project-config',
      mode: 0o644,
    },
    ...(skills
      ? [
          {
            kind: 'skills-ignore' as const,
            root: join(selection.git.checkout.rootPath, '.agents', 'skills'),
            anchor: selection.git.checkout.rootPath,
            path: '.gitignore',
            content: initializationIgnore,
            owner: 'astack:init:skills-ignore',
            mode: 0o644 as const,
          },
        ]
      : []),
  ];
}

export async function inspectInitializationAsset(
  plan: InitializationAssetPlan,
  deps: { files: ManagedFileStore; layout: InitializationFiles },
): Promise<InitializationAsset> {
  const base: InitializationAsset = {
    kind: plan.kind,
    root: plan.root,
    path: plan.path,
    state: 'planned',
    reason: null,
    inspection: null,
    write: null,
  };
  const directory = await deps.layout.directory(plan.root, plan.anchor);

  if (directory.outcome === 'rejected') {
    return { ...base, state: 'blocked', reason: directory.error.code };
  }

  if (directory.value === 'missing') {
    return base;
  }

  const inspection = await inspectManagedFile(
    { schemaVersion: 1, root: plan.root, path: plan.path },
    deps.files,
  );
  base.inspection = inspection;

  if (inspection.outcome === 'rejected') {
    return { ...base, state: 'blocked', reason: inspection.error.code };
  }

  if (inspection.outcome === 'blocked') {
    return { ...base, state: 'blocked', reason: inspection.reason };
  }

  if (inspection.state === 'pending') {
    return { ...base, state: 'pending', reason: 'pending_writer' };
  }

  if (inspection.state === 'missing') {
    return { ...base, state: 'missing' };
  }

  if (inspection.state !== 'managed' || inspection.record?.owner !== plan.owner) {
    return { ...base, state: 'preserved', reason: inspection.state };
  }

  if (
    inspection.record.sha256 === sha256(plan.content) &&
    inspection.record.assetVersion === initializationAssetVersion &&
    inspection.record.mode === plan.mode
  ) {
    return { ...base, state: 'current' };
  }

  return { ...base, state: 'planned' };
}

export async function writeInitializationAsset(
  plan: InitializationAssetPlan,
  deps: { files: ManagedFileStore; layout: InitializationFiles },
  signal?: AbortSignal,
): Promise<InitializationAsset> {
  const before = await inspectInitializationAsset(plan, deps);

  if (['preserved', 'blocked', 'pending', 'current'].includes(before.state)) {
    return before;
  }

  const write = await writeManagedFile(
    {
      schemaVersion: 1,
      root: plan.root,
      path: plan.path,
      owner: plan.owner,
      assetVersion: initializationAssetVersion,
      mode: plan.mode,
      content: plan.content,
    },
    deps.files,
    signal,
  );

  return {
    ...before,
    write,
    state:
      write.outcome === 'written' || write.outcome === 'unchanged'
        ? write.outcome
        : write.outcome === 'pending'
          ? 'pending'
          : write.outcome === 'blocked' &&
              ['unowned_file', 'modified_file', 'owner_mismatch'].includes(write.reason)
            ? 'preserved'
            : 'blocked',
    reason: 'reason' in write ? write.reason : 'error' in write ? write.error.code : null,
  };
}

export function initializationDiagnostic(view: InitializationView, code: string, message: string) {
  if (!view.diagnostics.some((item) => item.code === code)) {
    view.diagnostics.push({ code, message });
  }
}
