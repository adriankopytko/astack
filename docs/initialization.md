# Conservative project initialization

`initializeProject` and `astack init` compose existing registration, managed-file, skill, configuration and Herdr operations. They initialize one explicitly selected repository. They never scan/register every child of a collection directory. See ADR 0022.

## Inputs and selection

```sh
astack init /absolute/project --preview --json
astack init /absolute/project --id project-example --non-interactive --json
astack init /absolute/project --role implementer --role reviewer --json
astack init --project project-example --herdr --json
astack init /absolute/project --herdr-session selected-session --herdr-socket /absolute/socket --json
```

A caller inside a repository can omit the path; subdirectories resolve to the repository root. From a neutral directory select a path or saved `--project`/`--checkout`. Explicit selectors must agree and take precedence over caller discovery. `--id` assigns or asserts a saved project ID. The library takes version 1 requests with explicit selectors, injected dependencies, selected user-skills and private host roots. CLI relative paths resolve against the caller once.

The primary checkout must be registered before initializing an unregistered linked checkout. Registered linked checkouts share project/repository identity, retain distinct checkout IDs, and use the saved primary for Herdr. Astack-owned task checkouts are refused. Repeated identity and branch/HEAD checks guard stage transitions; they do not provide an atomic filesystem snapshot or prevent hostile same-user renames. The host must coordinate repository writers.

## Preview and effects

Preview inspects Git identity, bounded manifest signals, managed assets, selected skill availability and saved configuration. It creates no state, directories, registration, files or provider resources and does not contact Herdr. An absent state store is read through an empty registry. A new project's preview cannot allocate its eventual generated IDs; the private-policy target is consequently a placeholder until registration.

Apply holds kernel-backed coordinator ownership before writable database migration and throughout setup; an active service/coordinator must be stopped first. It persists registration before file/provider effects. Setup writes are individually managed, not one atomic batch:

| Target                                  | New content                                                                               | Mode |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | ---- |
| `.astack/.gitignore`                    | Managed stage and pending-journal exclusions                                              | 0644 |
| `.astack/project.json`                  | Null runtime/command/hook proposals                                                       | 0644 |
| `<state>/config/<project-id>.json`      | Disabled private host-policy starter; no runtime, command, environment or skill approvals | 0600 |
| `.agents/skills/.gitignore`             | Same operational exclusions, when roles selected                                          | 0644 |
| `.agents/skills/astack-<role>/SKILL.md` | Explicitly selected packaged guides                                                       | 0644 |

Directories are created privately; existing unsafe/symlinked project parents are refused. The private configuration directory must remain private. Public source files use Git-compatible modes so cloned/linked checkouts retain valid ownership evidence. Ownership/version/digest records are stored alongside the selected roots; completed project records may be tracked, but pending journals and stages must never be committed. Generated ignore files precede other project assets. Authored ignore files are preserved, so verify their exclusions yourself; a failure publishing the ignore file can leave an unignored pending journal.

Existing instructions, scripts, environments, unrelated skills, authored/edited/deleted/foreign managed files and unresolved writer intents are preserved. There is no adoption, force, deletion or automatic pending-write reconciliation. Existing authored private host setup also preserves an absent proposal, avoiding new repository settings that would invalidate that established baseline. No private settings are copied into repository files.

Codex's documented project skill location is `.agents/skills`; see [official skill discovery documentation](https://learn.chatgpt.com/docs/build-skills). Selected roles are optional and never automatically attached to assignments. Initialization only inspects user-level orchestrator availability at Astack's selected skill root (the existing `$CODEX_HOME/skills` or `~/.codex/skills` default, or explicit `--user-skills-root`). This is a selected compatibility/profile root, not a guarantee about every agent version's discovery configuration. It never installs globally or rewrites agent settings. Use explicit `skills install` at the appropriate selected profile root separately.

## Detection, provider and readiness

Detection reads bounded `package.json` data and presence of recognized manifests/lockfiles. Output includes known script names and package-manager candidates, never script bodies or environment contents. Only declared test/lint/typecheck scripts with an unambiguous manager become verification suggestions. Rust/Python/Go manifest presence supplies stack hints without invented commands. Ambiguous or unreadable inputs produce diagnostics. No project code runs. Hook execution is available through explicit [owned-checkout lifecycle operations](hooks.md); initialization never invokes it and starters keep hook bindings null.

Herdr is opt-in. `--herdr` uses saved settings; a new target requires both `--herdr-session` and `--herdr-socket`. `--herdr-label` labels new settings. Existing settings are preserved on conflict; deliberate retargeting uses existing explicit Herdr operations. Space creation uses the registered primary and existing durable provider intent. It creates no worker layouts, terminals or agents. Preview reports the requested plan without validating live provider readiness.

Registration, setup success and delegation readiness are separate. Results contain each role's configuration/prerequisite diagnostics, user/project skill evidence, provider status and a conservative delegation observation. A disabled starter normally reports `not_ready`. Even `requires_owned_checkout` still requires explicit owned checkout preparation, assignment acceptance, service/runtime opt-in and dispatch-time checks. Configuration readiness is an observation, not permission granted by initialization. Initialization never enables automatic review, mutates trackers, installs dependencies or starts services.

## Results, failures, retry and cancellation

Version 1 results are `previewed`, `initialized`, `partial` or a stable rejected operation result. `initialized` can coexist with `not_ready` or preserved authored assets. Requested skill/provider stages that cannot complete produce `partial`. JSON retains registration receipts, per-asset inspections/write results, configuration and provider evidence. Human output summarizes diagnostics. CLI exits nonzero on rejection/partial; noninteractive reporting is always the default (`--non-interactive` is explicit documentation of that behavior).

Successful stages remain durable on later failure; no rollback removes files, registry entries or primary spaces. Repeat setup reuses registration IDs and matching managed assets without replacing files. Pending file writers stop setup and retain journals. Pending Herdr creation stays pending on retry; reconcile through explicit Herdr operations after establishing the required stopped-writer evidence. Never retry uncertain effects by deleting metadata, age or PID absence. A caught adapter failure returns partial evidence plus an inspection requirement; missing evidence is not proof that no effect occurred.

An aborted request before setup performs no mutation. Cancellation during setup stops subsequent effects where supported but may retain empty directories, accepted registration, completed assets or pending intents. Host-supplied roots/dependencies and coordinator ownership remain part of the library preconditions; imports perform no IO.

Disposable tests cover read-only preview, fresh/repeated setup, authored and edited assets, directory failures, pending publication, provider uncertainty/recovery, linked checkout identity and Git modes, symlinked parents, and a packed CLI invoked from neutral directories. Default verification uses no live agents, GitHub writes or user-project resources.
