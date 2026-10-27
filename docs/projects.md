# Project registration and context

## Implemented commands

```sh
astack project register /projects/example --id example --json
astack project list --json
astack context --project example --json
astack context --path /projects/example/src --json
astack doctor --json
```

`doctor` is an alias for `context`. These commands provide local identity and diagnostics, not delegation. Global `--state-directory <path>` selects isolated state; global `--git-executable <absolute-path>` selects a trusted Git binary. Otherwise the CLI chooses Git from absolute host PATH entries. Library operations never perform ambient executable lookup or infer a project from service cwd.

`project register [path]` defaults to the caller directory. `--id` assigns or asserts a project ID; omission generates opaque IDs. Paths may be relative at the CLI boundary and are made absolute before calling the library. Registration writes only private local state, not project configuration, skills, hooks, Git branches, or tracked files. It does not initialize execution policy or authorize worker launch.

`project list` returns recorded registrations and primary checkout paths without contacting Git. Its default page size is 50; `--limit 1..100` and `--after <project-id>` provide deterministic pagination. Listed paths can be stale; inspect context before acting on them.

## Library and dependencies

- `registerProject(request, dependencies, signal?)` accepts `{ schemaVersion: 1, path, projectId? }`.
- `selectProjectContext(request, dependencies, signal?)` accepts `{ schemaVersion: 1, projectId?, checkoutId?, runId?, path?, callerDirectory? }` with at least one selector/directory.
- `listProjects(request, registry, signal?)` accepts `{ schemaVersion: 1, after?, limit? }`.

Inject `ProjectRegistry`, `GitInspector`, and `CheckoutIdentityReader`; registration additionally receives an ID generator and clock. `nodeCheckoutIdentityReader` observes canonical directory device/inode identities. `openSqliteState` now exposes `registry` alongside `store`; both share the same connection and close through `store.close()`. No imports or command construction open state or query providers.

Registration returns the existing `persisted`/`rejected`/`uncertain` write envelope. Context and list return completed/rejected read envelopes. Public schemas validate requests and decoded results. JSON commands print one result on stdout, with exit 0 for completed/persisted and 1 for rejected/uncertain. Commander syntax errors remain CLI errors. Plain output is a concise diagnostic rendering.

## Stable identities and deliberate registration

Project, repository, and checkout IDs are separate. Canonical Git common-directory identity groups linked worktrees; independent clones have different identities regardless of shared remotes, commit history, or basename. Basenames and remote URLs never select or merge projects.

The first explicit registration establishes the primary checkout. Registering another linked checkout deliberately adds a separate checkout ID to the same project without changing its primary. Repetition preserves IDs and original registration timestamps. Conflicting explicit IDs, occupied paths, or changed records reject; concurrent registrations can return a storage conflict and require an explicit retry. No new writer/provider operation is launched by a retry.

Migration 2 adds explicit project/checkout registration markers; migration 1 is unchanged. Existing storage projections are not automatically registered. A deliberate registration can reuse consistent existing primary projections. Register that primary first before attaching additional checkouts. One local repository identity can belong to one registered project.

Registration retains canonical root, Git directory, and common-directory filesystem device/inode observations. Context compares fresh identity observations against them. A replaced directory is rejected even if the path and remote URL are unchanged. Registration rechecks locations immediately before its state write, and database constraints serialize competing identity claims.

Moved or replaced registrations are preserved and rejected as stale; this issue provides no automatic relocation/adoption operation. An explicit old ID cannot be rebound to a new path. A moved repository at an unknown path can be diagnosed as unregistered; without an old-ID assertion it is indistinguishable from another local clone and can receive a new registration. Device/inode values are host-local observations, not portable identity, authorization, or protection from every filesystem race/inode reuse. Trusted roots and fresh checks before effects remain required.

## Selection rules

| Selectors                              | Resolution                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runId` / `--run`                      | Bind to the persisted attempt's project, repository, and checkout. Explicit project/checkout/path assertions must agree. |
| `checkoutId` / `--checkout`            | Select that registered checkout; an explicit project/path must agree.                                                    |
| `projectId` / `--project` without path | Select the registered project's primary checkout.                                                                        |
| Explicit `path` / `--path`             | Inspect the nearest Git checkout and match its canonical root; an explicit project must agree.                           |
| No explicit selector                   | Inspect the nearest repository from the supplied `callerDirectory`.                                                      |

Explicit targets ignore ambient caller-directory context, so a project can be selected from a collection directory or another project. An explicit path is an assertion, not ambient context. Linked checkouts of the same project remain distinct when a checkout/run is bound. The nearest nested repository wins. A collection/non-Git directory never triggers a scan of child repositories, even if only one child looks eligible. Supply an explicit target instead.

`runId` currently names an existing persisted attempt ID from the storage primitive. It is a binding mechanism for future run operations; the CLI cannot submit jobs or create runs yet. Returned `run.commit`/`run.branch` describe the saved assignment, while `git.checkout.head` describes the fresh observation. A worker committing new work does not silently change its assignment or require its current HEAD to equal the original base commit. This read is not worker authentication, a current execution-state check, or provider-handle validation.

Unregistered repositories can be inspected without registration. A linked checkout of a known project remains `unregistered-checkout` until deliberately registered. Explicit project/checkout selectors require registration; low-level saved projections alone do not authorize selection as a registered target.

## Doctor evidence and configuration provenance

Context reports selection source, registration state, project/checkout IDs, Git facts, saved-attempt binding where requested, and readiness. Git is marked ready only after successful inspection. Codex, Herdr, and GitHub are `not_checked`: their adapters/readiness probes are not implemented. Configuration provenance is `{ source: 'none', status: 'not_checked' }`, with reason `execution_policy_not_checked`: this identity operation does not resolve execution policy. Use `config inspect --project <id>` for the separate [trusted configuration operation](configuration.md). Repository configuration is never read as execution authority.

Delegation is always `unavailable` in this version. Reasons include missing registration when applicable, and unimplemented execution policy/delegation. Registration, a clean worktree, available Git, or a completed context read is not authority to execute project hooks or agents. Owned worktree lifecycle is available through [separate operations](worktrees.md). Project profiles, trusted host execution policy, Herdr spaces, and worker dispatch arrive in their respective issues.

## State access, failures and cancellation

Context/list use `openSqliteState({ ..., mode: 'read-only' })`. Read-only open does not create missing directories/databases, apply migrations, or enter write transactions; write methods reject with `state_read_only`. Missing/empty state uses an empty registry for diagnostics/listing. Corrupt, unsafe, incomplete, incompatible, or inaccessible state is an error and never silently treated as empty. Existing older schemas require an explicit read-write open (including deliberate registration) to migrate. SQLite may access/create its WAL shared-memory sidecars while reading; read-only here means no logical state/project mutation, not immutable filesystem access.

New project errors include `project_context_required`, `project_selector_conflict`, `project_registration_conflict`, `project_checkout_stale`, and `run_not_found`; existing project/checkout, Git, validation, and state errors retain their contracts. Messages are fixed rather than raw provider exceptions. Timeouts, incomplete Git output, unsafe state, and provider failures remain errors, not evidence of an unregistered or empty project.

Validation precedes cancellation. Cancellation is checked between reads and before persistence, and forwarded to Git execution. Filesystem identity reads and SQLite lock waits are cooperative/bounded by their existing mechanisms. Once the synchronous registration transaction runs, its committed/uncertain outcome is retained rather than relabeled cancelled. A thrown storage implementation at that boundary produces `uncertain`; reopen/inspect instead of assuming nothing was stored.

Completed context is an observation across Git, filesystem, and database reads, not an atomic snapshot, owned-resource lease, or durable job acceptance. Freshly recheck identity, branch/SHA, effective execution policy, and ownership immediately before any effect. No source files, agents, ports, workspaces, or GitHub objects are changed by context resolution.

## Project setup

Use [explicit initialization](initialization.md) to compose registration with conservative managed configuration, optional project skills and an explicitly selected primary Herdr space. `project register` retains its state-only behavior. `init --preview` is read-only; applying setup preserves authored files and reports delegation readiness separately.
