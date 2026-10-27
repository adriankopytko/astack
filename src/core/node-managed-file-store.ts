import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, link, mkdir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  maximumManagedFileBytes,
  type ManagedFileRequest,
  type ManagedFileResult,
  type ManagedFileRecord,
  type ManagedWriteIntent,
  type InspectManagedFileRequest,
  type ManagedFileInspection,
} from '../contracts/managed-files.js';
import { rejected } from '../contracts/operation-result.js';
import {
  canonicalFileRoot,
  checkedFilePath,
  exclusiveFile,
  FileSafetyError,
  fileProblem,
  hasFileCode,
  readRegularFile,
  sameFile,
  sameSnapshot,
  sha256,
  type FileRoot,
  type FileSnapshot,
} from './file-paths.js';
import {
  ensureMetadata,
  hasMetadata,
  loadPending,
  loadRecord,
  metadataPaths,
  stagePath,
} from './managed-file-metadata.js';

export interface ManagedWriteProgress {
  phase: 'prepared' | 'published' | 'recorded';
  root: string;
  intent: ManagedWriteIntent;
}

function observation(
  current: FileSnapshot | null | undefined,
  record: ManagedFileRecord | null,
  pending: ManagedWriteIntent | null,
): 'missing' | 'unowned' | 'matches-record' | 'matches-intent' | 'modified' | 'unverified' {
  if (current === undefined) {
    return 'unverified';
  }

  if (!current) {
    return 'missing';
  }

  if (
    pending &&
    current.sha256 === pending.after.sha256 &&
    Number(current.info.mode & 0o777n) === pending.after.mode
  ) {
    return 'matches-intent';
  }

  if (!record) {
    return 'unowned';
  }

  return current.sha256 === record.sha256 && Number(current.info.mode & 0o777n) === record.mode
    ? 'matches-record'
    : 'modified';
}

function eligibility(
  current: FileSnapshot | null,
  record: ManagedFileRecord | null,
  request: ManagedFileRequest,
) {
  if (!record && current) {
    throw new FileSafetyError('unowned_file');
  }

  if (record && record.owner !== request.owner) {
    throw new FileSafetyError('owner_mismatch');
  }

  if (
    record &&
    (!current ||
      current.sha256 !== record.sha256 ||
      Number(current.info.mode & 0o777n) !== record.mode)
  ) {
    throw new FileSafetyError('modified_file');
  }

  return (
    record !== null &&
    record.sha256 === sha256(request.content) &&
    record.assetVersion === request.assetVersion &&
    record.mode === request.mode
  );
}

async function requireSnapshot(
  root: FileRoot,
  path: string,
  expected: FileSnapshot | null,
  reason: 'target_changed' | 'metadata_changed',
) {
  const actual = await readRegularFile(root, path, maximumManagedFileBytes);

  if (
    (actual === null) !== (expected === null) ||
    (actual &&
      expected &&
      (!sameSnapshot(actual.info, expected.info) || actual.sha256 !== expected.sha256))
  ) {
    throw new FileSafetyError(reason);
  }
}

async function unlinkOwned(
  root: FileRoot,
  path: string,
  identity: { dev: bigint; ino: bigint },
): Promise<void> {
  const absolute = await checkedFilePath(root, path);
  const current = await lstat(absolute, { bigint: true }).catch((error: unknown) => {
    if (hasFileCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  });

  if (current) {
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new FileSafetyError('target_changed');
    }

    await unlink(absolute);
  }
}

async function removeEmptyClaim(
  root: FileRoot,
  path: string,
  identity: BigIntStats,
): Promise<void> {
  const empty = await readRegularFile(root, path, 1);

  if (empty && empty.bytes.length === 0 && sameFile(empty.info, identity)) {
    await unlinkOwned(root, path, identity);
  }
}

export function createNodeManagedFileStore(
  options: { onProgress?: (event: ManagedWriteProgress) => Promise<void> } = {},
) {
  const onProgress = options.onProgress;

  async function write(
    request: ManagedFileRequest,
    signal?: AbortSignal,
  ): Promise<ManagedFileResult> {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      return rejected('unsupported_platform', 'Managed publication supports Linux and macOS only.');
    }

    if (signal?.aborted) {
      return { schemaVersion: 1, outcome: 'blocked', reason: 'cancelled' };
    }

    let root: FileRoot | undefined;
    let claim: FileHandle | undefined;
    let claimPath: string | undefined;
    let claimIdentity: BigIntStats | undefined;
    let intent: ManagedWriteIntent | undefined;

    try {
      root = await canonicalFileRoot(request.root);
      const initial = await loadRecord(root, request.path);

      if (await loadPending(root, request.path)) {
        return { schemaVersion: 1, outcome: 'blocked', reason: 'busy' };
      }

      const first = await readRegularFile(root, request.path, maximumManagedFileBytes);

      if (eligibility(first, initial.record, request) && initial.record) {
        return { schemaVersion: 1, outcome: 'unchanged', root: root.path, record: initial.record };
      }

      if (signal?.aborted) {
        throw new FileSafetyError('cancelled');
      }

      await ensureMetadata(root);
      const paths = metadataPaths(request.path);
      claim = await exclusiveFile(root, paths.pending).catch((error: unknown) => {
        if (hasFileCode(error, 'EEXIST')) {
          throw new FileSafetyError('busy');
        }

        throw error;
      });
      claimPath = paths.pending;
      claimIdentity = await claim.stat({ bigint: true });
      const previous = await loadRecord(root, request.path);
      const current = await readRegularFile(root, request.path, maximumManagedFileBytes);

      if (eligibility(current, previous.record, request) && previous.record) {
        return { schemaVersion: 1, outcome: 'unchanged', root: root.path, record: previous.record };
      }

      const transactionId = randomUUID();
      const record: ManagedFileRecord = {
        schemaVersion: 1,
        path: request.path,
        owner: request.owner,
        assetVersion: request.assetVersion,
        sha256: sha256(request.content),
        mode: request.mode,
      };
      intent = {
        schemaVersion: 1,
        transactionId,
        before: previous.record,
        after: record,
        stagePath: stagePath(request.path, transactionId),
      };
      const journal = JSON.stringify(intent) + '\n';
      await claim.writeFile(journal);
      await claim.sync();
      const stageDirectory = dirname(intent.stagePath);
      await mkdir(await checkedFilePath(root, stageDirectory), { mode: 0o700 });
      const staged = await exclusiveFile(root, intent.stagePath);
      let stagedIdentity;

      try {
        await staged.writeFile(request.content, 'utf8');
        await staged.chmod(request.mode);
        await staged.sync();
        stagedIdentity = await staged.stat({ bigint: true });
      } finally {
        await staged.close();
      }

      await onProgress?.({ phase: 'prepared', root: root.path, intent: structuredClone(intent) });

      if (signal?.aborted) {
        throw new FileSafetyError('cancelled');
      }

      await requireSnapshot(root, request.path, current, 'target_changed');
      await requireSnapshot(root, paths.record, previous.snapshot, 'metadata_changed');
      const image = await readRegularFile(root, intent.stagePath, maximumManagedFileBytes);

      if (!image || image.sha256 !== record.sha256 || !sameSnapshot(image.info, stagedIdentity)) {
        throw new FileSafetyError('target_changed');
      }

      const targetPath = await checkedFilePath(root, request.path);
      const stagedPath = await checkedFilePath(root, intent.stagePath);
      await hasMetadata(root);
      await requireSnapshot(root, request.path, current, 'target_changed');

      if (current) {
        await rename(stagedPath, targetPath);
      } else {
        await link(stagedPath, targetPath);
        await unlinkOwned(root, intent.stagePath, stagedIdentity);
      }

      await onProgress?.({ phase: 'published', root: root.path, intent: structuredClone(intent) });
      const published = await readRegularFile(root, request.path, maximumManagedFileBytes);

      if (
        !published ||
        published.sha256 !== record.sha256 ||
        !sameFile(published.info, stagedIdentity) ||
        Number(published.info.mode & 0o777n) !== record.mode
      ) {
        throw new FileSafetyError('target_changed');
      }

      const recordStage = `${paths.record}.${transactionId}.tmp`;
      const stagedRecord = await exclusiveFile(root, recordStage);
      let recordIdentity;

      try {
        await stagedRecord.writeFile(JSON.stringify(record) + '\n');
        await stagedRecord.sync();
        recordIdentity = await stagedRecord.stat({ bigint: true });
      } finally {
        await stagedRecord.close();
      }

      await requireSnapshot(root, paths.record, previous.snapshot, 'metadata_changed');
      const recordTarget = await checkedFilePath(root, paths.record);
      const recordSource = await checkedFilePath(root, recordStage);

      if (previous.record) {
        await rename(recordSource, recordTarget);
      } else {
        await link(recordSource, recordTarget);
        await unlinkOwned(root, recordStage, recordIdentity);
      }

      await onProgress?.({ phase: 'recorded', root: root.path, intent: structuredClone(intent) });
      await rmdir(await checkedFilePath(root, stageDirectory));
      const pending = await readRegularFile(root, paths.pending, maximumManagedFileBytes);

      if (
        !pending ||
        pending.sha256 !== sha256(journal) ||
        !sameFile(pending.info, claimIdentity)
      ) {
        throw new FileSafetyError('metadata_changed');
      }

      await claim.close();
      claim = undefined;
      await unlinkOwned(root, paths.pending, claimIdentity);

      return { schemaVersion: 1, outcome: 'written', root: root.path, record };
    } catch (error) {
      if (intent && root) {
        return {
          schemaVersion: 1,
          outcome: 'pending',
          root: root.path,
          reason: fileProblem(error),
          intent,
        };
      }

      return { schemaVersion: 1, outcome: 'blocked', reason: fileProblem(error) };
    } finally {
      if (claim && root && claimPath && claimIdentity && !intent) {
        // Uncertain or edited claim files stay in place; never remove them speculatively.
        await removeEmptyClaim(root, claimPath, claimIdentity).catch(() => {});
      }

      await claim?.close().catch(() => {});
    }
  }

  async function inspect(request: InspectManagedFileRequest): Promise<ManagedFileInspection> {
    try {
      const root = await canonicalFileRoot(request.root);
      const { record } = await loadRecord(root, request.path);
      const pending = await loadPending(root, request.path);

      if (pending) {
        const current = await readRegularFile(root, request.path, maximumManagedFileBytes).catch(
          () => undefined,
        );

        return {
          schemaVersion: 1,
          outcome: 'inspected',
          root: root.path,
          state: 'pending',
          observation: observation(current, record, pending),
          record,
          pending,
        };
      }

      const current = await readRegularFile(root, request.path, maximumManagedFileBytes).catch(
        (error: unknown) => {
          if (error instanceof FileSafetyError && error.reason === 'missing_parent') {
            return null;
          }

          throw error;
        },
      );
      let state: 'missing' | 'unowned' | 'managed' | 'modified';

      if (record) {
        state =
          current &&
          current.sha256 === record.sha256 &&
          Number(current.info.mode & 0o777n) === record.mode
            ? 'managed'
            : 'modified';
      } else {
        state = current ? 'unowned' : 'missing';
      }

      return {
        schemaVersion: 1,
        outcome: 'inspected',
        root: root.path,
        state,
        observation: observation(current, record, null),
        record,
        pending: null,
      };
    } catch (error) {
      return { schemaVersion: 1, outcome: 'blocked', reason: fileProblem(error) };
    }
  }

  return { write, inspect };
}

export const nodeManagedFileStore = createNodeManagedFileStore();
