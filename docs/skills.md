# Versioned role skills

Astack ships focused `astack-orchestrator`, `astack-implementer` and `astack-reviewer` skills alongside the existing `astack --skill` command guide. They cover currently implemented behavior. Skill installation does not initialize a project, approve execution policy, launch a worker or rewrite agent settings.

## Discover and use

```sh
astack skills list --json
astack skills show orchestrator
astack skills show implementer
astack skills show reviewer
astack skills inspect --json
astack skills install --json
astack skills install --role orchestrator --json
astack skills inspect --root /absolute/selected/skills --role orchestrator --json
```

`show` prints the requested SKILL.md by default; `--json` adds its version/digest/catalog identity to the text. `list` reports the three packaged assets and their provenance without printing all instructions. `--skill`, `--help` and ordinary operation JSON retain their previous behavior. `--role` selects installation/inspection roles; the existing global `--skill` remains the command-guide option.

The default user setup root is `$CODEX_HOME/skills` when CODEX_HOME is set, otherwise `~/.codex/skills`. This makes the orchestrator guide discoverable outside any project repository. Explicit `--root` selects another agent's compatible skills directory or an isolated profile. Relative CLI roots resolve once against the caller's directory; library operations require an explicit absolute root. No project search or ambient pane determines the installation target. Packaged assets resolve from the installed module, independently of cwd.

`inspect` opens neither service nor SQLite state and creates no directories or metadata. It reports `rootExists`, availability for the selected roles, expected version/digest, actual ownership record, and per-role management evidence. `astack init` consumes the same `inspectSkills` operation to report user-level orchestrator availability without installing or modifying user setup. Use `--user-skills-root` to select that inspection profile. See [project initialization](initialization.md).

Installation is an explicit user setup action. Development/verification of Astack never installs into the developer's real user skills directory automatically. The source tool `pnpm skills:manifest` updates catalog digests after formatting intentional asset changes; it does not install anything.

## Role scope

The orchestrator skill explains explicit identity/configuration selection, dedicated checkout preparation, delegation, local event waiting, report acceptance, decisions, explicit publication, review/fix handoff and lifecycle recovery. It distinguishes supported host attestations from future executed verification/hooks. It does not grant user permission or host policy.

The implementer skill consumes the exact assigned run/attempt/checkout/branch/base SHA and task, honors project instructions and commit authorization, and returns a structured proposal. It cannot choose another task, accept its own report, publish, launch sibling workers or clean up its runtime.

The reviewer skill consumes the exact PR/full SHA/base/gate/snapshots in a dedicated read-only checkout. It returns numeric-line findings and preserves historical scope. It cannot edit code, start services, approve/merge, publish findings or convert itself into an implementer. The original assignment's result schema remains authoritative; these optional guides do not change saved runtime prompt bytes or delivery generations.

These are instructions, not an OS security boundary. Native profiles, private host controls, current assignment/report validation and actual process permissions still enforce operation authority. Installing a guide does not attach it to accepted jobs or approve its path/digest automatically. Hosts can deliberately reference the returned version/digest using the existing configuration skill pins and approve the installed absolute path through private execution policy. Updates do not rewrite those pins or immutable job snapshots; changed bytes can block fresh dispatch under an old approval. Coordinate upgrades with affected pinned jobs or select a separate root for another profile.

## Bundle and provenance

`skills/manifest.json` is a strict versioned catalog with namespace `astack`, bundle version, three role IDs, namespaced names, descriptions, individual asset versions, fixed relative SKILL.md paths and exact SHA-256 digests. Each SKILL.md also declares its name, description and asset version. Only the known names/paths are permitted. Reads validate the whole bundle, including bounded UTF-8 asset bytes and digests, before installation can start. A missing/changed asset or invalid catalog returns `skill_bundle_invalid`; it never silently blesses new bytes.

Managed-file records use `astack:skill:<role>` owners, individual asset versions and exact file digests under the selected root's `.astack-managed`. They provide attribution and update evidence, not host execution authority. A changed digest under the same already-installed version is an `asset_version_conflict`; increment an intentionally changed asset's version rather than republishing a version silently. The bundle version and per-role versions are maintained deliberately. `pnpm skills:manifest` recomputes hashes only; it does not bump versions or approve policy.

All three guides are self-contained, one managed SKILL.md per role. No copied application-specific setup, generated settings, hooks, arbitrary scripts or untracked planning documents are needed. Each role becomes discoverable as a complete file publication; installation across several roles is not one atomic transaction.

## Installation preconditions and effects

Application operations take an injected `SkillBundleReader`, `SkillDirectories` and `ManagedFileStore`. Imports perform no IO. The filesystem implementations select trusted roots and use the existing managed-file write/inspection primitives.

The selected root must already exist or have an existing trusted immediate parent. A missing root and the known skill directories are created privately; installation does not recursively invent unknown parent structure. Existing root aliases are canonicalized. The filesystem adapter requires user-owned directories without group/other write permission and refuses symlinked or unsafe role subdirectories. It never removes directories. Use trusted roots and coordinate writers; portable filesystem checks do not isolate against hostile same-user rename races.

All selected targets are inspected before directory preparation, then again before the first file write. An existing authored SKILL.md blocks even when its bytes happen to match the bundle. An unowned nonempty role directory without an entrypoint also blocks. Empty directories may receive the new file. Edited files, missing/deleted owned files or parents, other owners, unsafe metadata and unresolved intents remain preserved. Known conflicts stop the selection before file publication. Existing unrelated skills, configuration files and authored support files are not edited or removed. There is no force/adopt/delete option.

New role directories and generated metadata directories use mode 0700; installed SKILL.md files use mode 0600 by default. Explicit `--project-scope` inspection/installation (library `mode: 0o644`) uses Git-compatible mode 0644; `init --role` selects this mode for project-local skills under `.agents/skills`. Do not switch modes on an existing installation casually: mode is part of ownership evidence. The managed writer records intent before publication, checks ownership/content/mode and safely publishes whole files. Matching repeat installations return unchanged and preserve target inodes. Owned older versions can update only when their observed bytes/mode still match the ownership record. Choosing an older trusted bundle explicitly can install that version; version strings do not authorize automated downgrades or background updates.

## Results, cancellation and retry

`listSkills`, `showSkill` and `inspectSkills` return version 1 operation results. Read-only availability can be false without turning inspection into an installation or an error. Invalid requests select no roots and invoke no writers. The CLI returns a nonzero exit for failed reads and blocked/pending installs; a completed inspection with missing skills remains a successful read.

`installSkills` returns `installed`, `unchanged`, `blocked`, `pending`, or a sanitized rejected result. Its view contains the last successful installation observation and per-role managed-file evidence. `writes` records every attempted role's returned primitive result. If an injected writer throws without returning evidence, that role has `result: null` and the installation remains pending; null never means no file effect occurred. Successful prior writes remain recorded and are not rolled back or deleted. A failed final inspection likewise preserves the known completed file receipts and returns pending.

An aborted request before setup performs no writes. Cancellation during directory preparation can leave empty selected directories. Cancellation or a failure during per-file publication stops subsequent roles; completed writes and pending metadata remain. There is no timeout/age/PID-based unlock, automatic reconciliation, deletion of claims, or unconditional retry of uncertain publication. Inspect the exact root/role and preserve its intent before choosing the managed-file recovery path. Repeated installation is safe for observed current records; pending intents stay pending. See [managed-file recovery limits](managed-files.md).

## Verification

Isolated tests cover read-only inspection, explicit private installation, inode-preserving repeats, owned upgrades and version reuse conflicts, authored/foreign/edited/deleted target preservation, symlinks, pending and throwing writes, request validation/cancellation, report-example schemas, and guide command/option consistency. A real `pnpm pack` archive is extracted into a disposable directory; the compiled CLI resolves every role and the canonical guide there, then installs only into an isolated user scope while preserving authored agent settings. No default check starts agents, changes GitHub or modifies real user setup.
