import {
  skillBundleSchema,
  skillsReadSchema,
  skillShowSchema,
  skillsInspectSchema,
  type SkillBundle,
  type SkillId,
  type SkillAsset,
  type SkillInstallation,
  type SkillsInstallationView,
  type SkillsInstallResult,
} from '../contracts/skills.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { ManagedFileInspection } from '../contracts/managed-files.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import { sha256 } from '../core/file-paths.js';
import type { ManagedFileStore } from '../ports/managed-file-store.js';
import type { SkillBundleReader, SkillDirectories } from '../ports/skills.js';
import { inspectManagedFile, writeManagedFile } from './managed-files.js';
export interface SkillsDependencies {
  bundle: SkillBundleReader;
  files: ManagedFileStore;
  directories: SkillDirectories;
}
const owner = (id: SkillId) => `astack:skill:${id}`;
async function readBundle(reader: SkillBundleReader): Promise<OperationResult<SkillBundle>> {
  try {
    const result = await reader.read();

    if (result.outcome === 'rejected') {
      return result;
    }

    const parsed = skillBundleSchema.safeParse(result.value);

    if (
      !parsed.success ||
      parsed.data.catalog.skills.some((asset) => {
        const content = parsed.data.contents.find((item) => item.id === asset.id)?.content;

        return content === undefined || sha256(content) !== asset.sha256;
      })
    ) {
      return rejected(
        'skill_bundle_invalid',
        'The installed skill bundle does not match its versioned catalog.',
      );
    }

    return completed(parsed.data);
  } catch {
    return rejected(
      'skill_bundle_invalid',
      'The installed skill bundle is unavailable or invalid.',
    );
  }
}

export async function listSkills(input: unknown, deps: Pick<SkillsDependencies, 'bundle'>) {
  const request = parseOperationRequest(skillsReadSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const result = await readBundle(deps.bundle);

  return result.outcome === 'rejected' ? result : completed(result.value.catalog);
}

export async function showSkill(input: unknown, deps: Pick<SkillsDependencies, 'bundle'>) {
  const request = parseOperationRequest(skillShowSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const result = await readBundle(deps.bundle);

  if (result.outcome === 'rejected') {
    return result;
  }

  const asset = result.value.catalog.skills.find((item) => item.id === request.value.id)!;
  const content = result.value.contents.find((item) => item.id === request.value.id)!.content;

  return completed({ asset, content });
}

function classify(
  asset: SkillAsset,
  inspection: ManagedFileInspection | null,
  directory: 'missing' | 'empty' | 'present',
): SkillInstallation {
  const record = inspection?.outcome === 'inspected' ? inspection.record : null;
  const base = { asset, record, inspection };

  if (inspection === null) {
    return { ...base, state: 'missing', reason: null };
  }

  if (inspection.outcome === 'blocked') {
    return inspection.reason === 'missing_parent' && directory === 'missing'
      ? { ...base, state: 'missing', reason: null }
      : { ...base, state: 'conflict', reason: inspection.reason };
  }

  if (inspection.outcome === 'rejected') {
    return { ...base, state: 'conflict', reason: inspection.error.code };
  }

  if (inspection.state === 'pending') {
    return { ...base, state: 'pending', reason: 'pending_writer' };
  }

  if (inspection.state === 'missing' && record === null && directory !== 'present') {
    return { ...base, state: 'missing', reason: null };
  }

  if (inspection.state !== 'managed' || record?.owner !== owner(asset.id)) {
    return {
      ...base,
      state: 'conflict',
      reason:
        inspection.state === 'missing'
          ? 'unowned_skill_directory'
          : inspection.state === 'managed'
            ? 'owner_mismatch'
            : inspection.state === 'unowned'
              ? 'unowned_file'
              : 'modified_file',
    };
  }

  if (record.assetVersion === asset.version && record.sha256 !== asset.sha256) {
    return { ...base, state: 'conflict', reason: 'asset_version_conflict' };
  }

  return {
    ...base,
    state:
      record.assetVersion === asset.version &&
      record.sha256 === asset.sha256 &&
      record.mode === 0o600
        ? 'current'
        : 'outdated',
    reason: null,
  };
}

async function observeInstallation(
  bundle: SkillBundle,
  root: string,
  selected: SkillId[],
  deps: SkillsDependencies,
): Promise<OperationResult<SkillsInstallationView>> {
  try {
    const assets = selected.map((id) => bundle.catalog.skills.find((asset) => asset.id === id)!);
    const directories = await deps.directories.inspect(
      root,
      assets.map((asset) => asset.name),
    );

    if (directories.outcome === 'rejected') {
      return directories;
    }

    const skills: SkillInstallation[] = [];

    for (const asset of assets) {
      const directory = directories.value.directories.find((entry) => entry.name === asset.name);

      if (!directory) {
        return rejected('skills_unavailable', 'Skill directory observations are incomplete.');
      }

      const inspection = directories.value.exists
        ? await inspectManagedFile(
            { schemaVersion: 1, root: directories.value.root, path: asset.path },
            deps.files,
          )
        : null;
      skills.push(classify(asset, inspection, directory.state));
    }

    return completed({
      root: directories.value.root,
      rootExists: directories.value.exists,
      catalogVersion: bundle.catalog.version,
      available: skills.every((skill) => skill.state === 'current'),
      skills,
    });
  } catch {
    return rejected(
      'skills_unavailable',
      'Skill installation could not be inspected; preserve its managed metadata and pending writes.',
    );
  }
}

export async function inspectSkills(input: unknown, deps: SkillsDependencies) {
  const request = parseOperationRequest(skillsInspectSchema, input);

  if (!request.valid) {
    return request.result;
  }

  const result = await readBundle(deps.bundle);

  return result.outcome === 'rejected'
    ? result
    : observeInstallation(result.value, request.value.root, request.value.skills, deps);
}

export async function installSkills(
  input: unknown,
  deps: SkillsDependencies,
  signal?: AbortSignal,
): Promise<SkillsInstallResult> {
  const request = parseOperationRequest(skillsInspectSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Skill installation was cancelled before setup.');
  }

  const result = await readBundle(deps.bundle);

  if (result.outcome === 'rejected') {
    return result;
  }

  const bundle = result.value;
  let observed = await observeInstallation(bundle, request.value.root, request.value.skills, deps);

  if (observed.outcome === 'rejected') {
    return observed;
  }

  const blocked = (view: SkillsInstallationView) =>
    view.skills.some((skill) => ['conflict', 'pending'].includes(skill.state));

  if (blocked(observed.value)) {
    return {
      schemaVersion: 1,
      outcome: observed.value.skills.some((skill) => skill.state === 'pending')
        ? 'pending'
        : 'blocked',
      view: observed.value,
      writes: [],
    };
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Skill installation was cancelled before directory setup.');
  }

  let prepared;

  try {
    prepared = await deps.directories.prepare(
      observed.value.root,
      observed.value.skills.map((skill) => skill.asset.name),
      signal,
    );
  } catch {
    return rejected(
      'skills_unavailable',
      'Skill directories could not be prepared; inspect any created empty directories before continuing.',
    );
  }

  if (prepared.outcome === 'rejected') {
    return prepared;
  }

  observed = await observeInstallation(bundle, prepared.value.root, request.value.skills, deps);

  if (observed.outcome === 'rejected') {
    return observed;
  }

  if (blocked(observed.value)) {
    return { schemaVersion: 1, outcome: 'blocked', view: observed.value, writes: [] };
  }

  const writes: Extract<SkillsInstallResult, { writes: unknown }>['writes'] = [];

  for (const skill of observed.value.skills) {
    const content = bundle.contents.find((item) => item.id === skill.asset.id)!.content;
    let write;

    try {
      write = await writeManagedFile(
        {
          schemaVersion: 1,
          root: observed.value.root,
          path: skill.asset.path,
          owner: owner(skill.asset.id),
          assetVersion: skill.asset.version,
          mode: 0o600,
          content,
        },
        deps.files,
        signal,
      );
    } catch {
      writes.push({ id: skill.asset.id, result: null });
      const latest = await observeInstallation(
        bundle,
        observed.value.root,
        request.value.skills,
        deps,
      );

      return {
        schemaVersion: 1,
        outcome: 'pending',
        view: latest.outcome === 'completed' ? latest.value : observed.value,
        writes,
      };
    }

    writes.push({ id: skill.asset.id, result: write });

    if (!['written', 'unchanged'].includes(write.outcome)) {
      const latest = await observeInstallation(
        bundle,
        observed.value.root,
        request.value.skills,
        deps,
      );

      return {
        schemaVersion: 1,
        outcome: write.outcome === 'pending' ? 'pending' : 'blocked',
        view: latest.outcome === 'completed' ? latest.value : observed.value,
        writes,
      };
    }
  }

  const latest = await observeInstallation(bundle, observed.value.root, request.value.skills, deps);

  if (latest.outcome === 'rejected') {
    // Completed per-file writes are preserved even when the final observation fails.
    return { schemaVersion: 1, outcome: 'pending', view: observed.value, writes };
  }

  return {
    schemaVersion: 1,
    outcome: latest.value.available
      ? writes.some((write) => write.result?.outcome === 'written')
        ? 'installed'
        : 'unchanged'
      : 'blocked',
    view: latest.value,
    writes,
  };
}
