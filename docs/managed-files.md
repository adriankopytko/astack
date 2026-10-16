# Managed files and private artifacts

Issue #9 adds two library operations and shared internal artifact helpers. Project initialization and service recovery can compose these operations later; no new CLI command is introduced.

## Write and inspect

```ts
import { writeManagedFile, inspectManagedFile, nodeManagedFileStore } from 'astack';

const result = await writeManagedFile(
  {
    schemaVersion: 1,
    root: '/absolute/project/path',
    path: 'generated-config.json',
    owner: 'astack:project-config',
    assetVersion: '1',
    mode: 0o644,
    content: '{ "version": 1 }\n',
  },
  nodeManagedFileStore,
  // optional AbortSignal
);

const inspection = await inspectManagedFile(
  { schemaVersion: 1, root: '/absolute/project/path', path: 'generated-config.json' },
  nodeManagedFileStore,
);
```

`ManagedFileStore` is the injectable port; `nodeManagedFileStore` implements it on Linux/macOS. Operation entrypoints validate unknown input before calling the store. `createNodeManagedFileStore({ onProgress })` provides awaited `prepared`, `published`, and `recorded` checkpoints for host integration. Checkpoints receive cloned transaction metadata without file contents. Unexpected callback failures preserve a pending result, not a completed publication claim.

### Preconditions and ownership

- The caller selects an existing trusted root and authorizes the owner, relative target, content, and version. The operation does not infer a project or grant host execution permission.
- The explicit root may be an alias: it is resolved once to its canonical physical directory. That directory's device/inode anchor is checked again during subsequent path operations. Symlinks below it are refused, including dangling final symlinks and metadata links. Nonregular and multiply linked files are refused.
- Paths use relative POSIX components without absolute/drive prefixes, backslashes, empty components, `.`, `..`, or NUL. `.astack-managed` at the root and `.astack-stage-*` components are reserved. Parent directories must already exist; these operations do not invent project structure.
- New content is a UTF-8 string limited to 1 MiB. This is an asset writer for small generated configuration/instruction files, not a large-output store or secret provisioner.
- An existing target without an ownership record is an `unowned_file` collision, even when bytes match. Existing generated files must match the recorded owner, SHA-256 digest, and permission mode before upgrade. Edits, permission changes, and deletions block replacement; no adoption, force overwrite, or automatic resurrection is available.
- Modes are 0600 (default), 0644, 0700, or 0755. For Git-tracked generated assets select 0644/0755 deliberately: Git does not preserve all Unix permission bits. Private 0600/0700 assets are suitable for local setup.

Matching content/version/mode returns `unchanged` without replacing the target inode. Asset versions are opaque caller-selected identifiers; the writer does not infer version ordering or prevent an explicitly requested downgrade.

## Atomic publication and metadata

The store keeps small ownership records under the selected root:

```text
.astack-managed/
  root.json                         recognized format/version marker
  <sha256-of-relative-path>.json     owner, asset version, digest, mode, relative path
  <same-key>.pending.json            exclusive per-target claim and publication intent
```

Records have their own `schemaVersion: 1`. They contain no file bodies, copied environment, or raw exceptions. Completed records may be tracked alongside generated assets; they are attribution metadata, not a service permission grant. A service reviewing a PR must obtain ownership/execution authority from its trusted baseline, not treat proposed PR metadata as authority to overwrite host files.

Metadata directories are created as 0700. Existing directories may be readable, as in a checkout of tracked records, but group/other writable directories, symlinks, unknown markers, invalid records, and unsupported stored versions are refused. The store preserves them instead of resetting them.

A write proceeds as follows:

1. Inspect the target and ownership record, then acquire its pending file exclusively. Re-read target/record facts under that cooperative claim.
2. Write and sync a publication intent containing before/after records, a fresh transaction ID, and a relative stage path. The intent is recorded before target publication.
3. Create a private 0700 `.astack-stage-<id>` directory beside the target. Write the complete image, set its requested mode, and sync it before publication.
4. Recheck target identity/content/timestamps, record identity/content, staged image, and paths. Create a missing target with a hard link that atomically refuses an existing destination. Replace an eligible existing target with a same-filesystem rename of the completed image.
5. Verify the published image, stage and atomically publish its ownership record, then remove only this transaction's verified temporary entries and pending claim. No recursive cleanup is used.

Readers see a complete old or new target image; they do not see an in-place partial write. Target and ownership record are separate filesystem publications, not one atomic transaction. A failure between them remains explicit pending work. File data is synced before publication, but this is not a universal power-loss durability guarantee: directory-entry persistence and filesystem semantics vary.

### Concurrency boundary

Pending claims coordinate cooperating astack writers per target, including across processes. New-file publication never overwrites a destination that appears concurrently. Updates recheck observed edits immediately before replacement and preserve detected changes.

Portable Node APIs do not provide an inode/content compare-and-swap rename or directory-fd-relative traversal on both supported hosts. Existing-file updates therefore require a trusted, quiescent managed target or cooperating writers. An uncoordinated editor performing an atomic save between the final check and rename can race an update; adversarial parent-directory replacement is outside this primitive's containment guarantee. Applications must serialize upgrades and select trusted roots. This API is not a filesystem sandbox and must not be presented as protection against hostile same-user filesystem mutation.

## Results, cancellation, and interruption

| Outcome     | Meaning                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `rejected`  | Input/contract/platform rejection before file work                                             |
| `blocked`   | A precondition or read/setup failure prevented target publication; inspect the stable `reason` |
| `unchanged` | The observed target already matched its owned content/version/mode                             |
| `written`   | A complete image and ownership record were published, and the transaction's claim was removed  |
| `pending`   | The returned intent may have partially taken effect; retain it and inspect before any retry    |

Blocked reasons distinguish unsafe paths, missing parents, unowned/edited files, different owners, invalid metadata, existing claims, cancellation, and IO failure. Pending results retain canonical root, transaction ID, before/after digests and versions, stage path, and a stable reason; they never contain requested file bodies or source exceptions.

An already aborted signal causes no file work. Cancellation is checked before setup and before target publication; setup may have created recognized metadata. Cancellation after staging retains private evidence. Once target publication begins, the operation completes ownership recording rather than claiming cancellation undid the write. Filesystem calls are not hard real-time/cancellable.

`inspectManagedFile` performs no setup or cleanup. It returns record/pending metadata, a management state, and an observation:

- `matches-record` or `matches-intent`: current bytes/mode match that metadata.
- `missing`, `unowned`, or `modified`: current target differs or has no record.
- `unverified`: a pending transaction exists but the target cannot safely be read, including an in-flight hard-link interval.

Observations do not prove which writer is alive or whether a rename occurred when old/new bytes are identical. Inspection is not an atomic filesystem snapshot or a cleanup lease.

Failures and hard process exit leave journal/stage evidence. A later writer seeing a pending claim returns blocked; it does not break it based on PID, age, or a plausible digest. Unreadable/partial metadata is preserved and reported as invalid. Automatic reconciliation/abandonment needs the later service's verified writer ownership and an explicit recovery operation; this slice intentionally provides inspection rather than a force-unlock shortcut. Do not delete a pending claim merely because its client disconnected.

Private stage directories can contain the requested image. Keep pending claims, record staging files, and `.astack-stage-*` directories out of commits and wider-access reports. This repository ignores those operational entries; initialization must add any target-project ignore rules through its managed, additive setup contract. The writer itself does not edit a target project's authored ignore file. Completed ownership records contain relative paths and hashes and can remain tracked.

## Shared private-artifact helpers

The process runner now consumes `createPrivateArtifactDirectory` and `openPrivateArtifact` internally. The helpers create a unique 0700 directory under an explicit trusted parent, write a versioned `.astack-artifact.json` ownership marker, and exclusively open named files as 0600. Reopens verify directory identity, privacy, owner marker, and safe basename; they refuse collisions and symlinks instead of overwriting.

These are internal live capabilities, not serialized authorization tokens or generic resource-deletion APIs. Output remains in files; only references and bounded summaries belong in future database rows. The application selects its runtime artifact parent outside source checkouts. These generic primitives have no registry/Git discovery and cannot identify all source directories by themselves; they never choose the service cwd as an implicit output location.

Artifacts and markers remain after completion/failure for caller-owned retention. Empty/partial directories can remain after failed setup. No automatic dependency installation, secret generation, or log publication occurs. File bytes can contain sensitive caller/command data; permissions, explicit retention, and selected/redacted publication remain part of the consuming operation's contract.

## Verification

Isolated tests exercise create/repeat/upgrade, record persistence across instances, preservation of authored/edited/deleted files and modes, owner mismatch, root aliases, path escape, symlinks/hard links, malformed metadata, atomic visibility at checkpoints, a competing writer, real process exit during publication, cancellation boundaries, and private artifact ownership/collisions. Existing process-runner tests verify the shared helpers still preserve bounded/raw output and private permissions.
