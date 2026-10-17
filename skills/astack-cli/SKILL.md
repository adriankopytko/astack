---
name: astack-cli
description: Use the astack CLI to register projects, manage owned worktrees, inspect context and approved configuration, or discover installed orchestration capabilities before delegation.
---

# Using astack

## Discover capabilities

`astack --skill` prints this installed guide as Markdown with skill frontmatter. Invoke it without a subcommand. Use `astack --help` and command-specific `--help` for argument syntax. Help and command JSON remain available separately.

From the astack source repository use `pnpm dev` instead of `astack`; after building use `pnpm start`. An installed binary resolves this guide independently of cwd.

## Commands available now

| Command                                                                                           | Result                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `astack --skill`                                                                                  | Installed agent guide                                                                       |
| `astack --help` / `--version`                                                                     | Command discovery / version                                                                 |
| `astack info [--json]`                                                                            | Package information; not project/job status                                                 |
| `astack project register [path] [--id <project-id>] [--json]`                                     | Deliberately register a canonical checkout in local state; default path is caller directory |
| `astack project list [--limit <count>] [--after <project-id>] [--json]`                           | Paginated recorded project identities and primary checkout paths                            |
| `astack context [selectors] [--json]`                                                             | Inspect target identity, selection source, Git state, and readiness                         |
| `astack doctor [selectors] [--json]`                                                              | Alias for `context`                                                                         |
| `astack config inspect --project <id> [--role <name>] [--json]`                                   | Resolve approved configuration, provenance, and prerequisites; alias `config check`         |
| `astack worktree prepare --project <id> --key <key> --branch <branch> --base <full-sha> [--json]` | Prepare or verify an owned isolated checkout                                                |
| `astack worktree inspect <id> [--json]`                                                           | Observe ownership, phase, and Git evidence                                                  |
| `astack worktree remove <id> [--json]`                                                            | Remove a verified clean owned checkout; preserve its branch                                 |
| `astack worktree reconcile <id> --operation <id> --writer-stopped [--json]`                       | Settle interrupted state after trusted host quiescence confirmation                         |

Global `--state-directory <path>` selects isolated host state. `--git-executable <absolute-path>` selects trusted Git; otherwise the CLI searches absolute host PATH entries. Git inspection requires Git 2.45 or later.

Context selectors are `--project <project-id>`, `--checkout <checkout-id>`, `--run <attempt-id>`, and `--path <path>`.

## Select the intended target

- From a neutral directory or another project, use an explicit project ID, checkout ID, or path. `project list` supplies saved IDs; listed paths are recorded facts and can be stale.
- Without selectors, context inspects the nearest Git repository from caller cwd. A collection directory never causes child-project discovery or guessing.
- An explicit project selects its primary checkout unless an explicit path selects another checkout belonging to that project. An explicit checkout selects that checkout.
- A saved attempt binds its project/repository/checkout. Other explicit selectors must agree. `--run` uses an existing persisted attempt ID; this CLI cannot create runs yet. Saved assignment commits and observed HEAD are separate facts.
- Explicit targets override ambient cwd. An explicit `--path` is an assertion and must agree with other explicit selectors. Conflicts reject rather than falling back.

Context can inspect an unregistered repository without registering it or creating state. Register only when the user intends to establish a local project identity. Registration creates no project config, skills, worktrees, or execution policy. A linked checkout needs deliberate registration; it then shares project identity while keeping its own checkout ID. Independent clones and duplicate basenames remain separate.

Moved/replaced registrations reject as stale. Do not bypass this by silently selecting another checkout, changing IDs, or treating matching remotes as ownership. Relocation/reconciliation is not implemented yet.

## Interpret results

Read commands emit `{ schemaVersion: 1, outcome: 'completed', value: ... }` or `rejected` with a stable error code. Registration emits `persisted` with `disposition` and identities, `rejected`, or `uncertain`. A completed read is an observation; persisted registration is local identity evidence. Neither means an agent job was accepted.

After `uncertain`, inspect the registry and supplied identities before retrying persistence. No provider effect or automatic retry is implied. Missing state permits empty-registry diagnostics; unsafe/corrupt/incompatible state remains an error. Read-only commands do not migrate old schemas; deliberate registration or an explicit library read-write open can migrate them.

Doctor reports Git readiness, other providers as `not_checked`, configuration provenance as `none`/`not_checked`, and delegation as unavailable. Use `config inspect` for separate configuration evidence. Do not interpret registration or a clean checkout as execution authorization.

## Owned worktrees

Preparation requires a registered project, stable owner key, new task branch, and full local commit SHA. Optional `--checkout` selects a registered source and `--run` binds an existing saved attempt; branch/base must match that assignment. Existing branches are not adopted. Managed checkouts live in private containers under host state, and receive separate registered checkout IDs. Repeated prepare verifies/reuses the same resource; a pending reservation never launches a second writer.

Worktree outcomes include `prepared`, `reused`, `removed`, `reconciled`, `inspected`, `blocked`, and `pending`. Inspecting a pending record does not establish readiness. Routine removal preserves dirty, untracked, and ignored files, edited ownership markers, changed identities/branches, locked resources, and task branches. Attempt-bound cleanup also requires a terminal result and release of other retained resources. Host/runtime callers must independently establish that workers/services stopped.

After interruption, inspect the record and exact operation ID. Use `--writer-stopped` only after the trusted host/operator has verified the original writer and its children stopped. The flag is an attestation, not an automatic process check. Never infer it from PID absence, age, agent idleness, or a worker/PR assertion. Reconcile reads provider/filesystem evidence and settles state without repeating Git creation/removal. Unmarked containers and branch-only partial creation remain preserved; no force, branch deletion, or automatic repair is available.

Worktree creation currently rejects configured content-filter commands and sparse checkout until execution profiles support them. Project provisioning, LFS/submodule initialization, hooks, and agent launch are separate future capabilities. Do not bypass a blocked/pending outcome by choosing a different directory or forcing Git cleanup.

## Approved project and role configuration

Use `astack config inspect --project <id> [--checkout <id>] [--role implementer] [--json]` (alias `config check`). It reads existing state and reports effective settings, leaf provenance, pinned skill versions/digests, and actionable prerequisites. Exit 1 means blocked or rejected; readiness launches no command and grants no durable execution capability.

Portable `.astack/project.json` is a proposal. The trusted host/operator maintains `<state-directory>/config/<project-id>.json` outside repositories with private directory/file permissions. Registration does not create or approve it. Do not copy a worker/PR proposal into this file as an automatic repair. Review and approval belong to the host/operator; there is no approval/init command yet.

Settings resolve defaults → user → approved project → local → request. Objects merge by fields; arrays replace completely. Host-only permissions, timeout limits and mandatory hooks apply after merging. A changed proposal blocks until reviewed; it never grants new permissions. Missing executables, approved environment names or exact protected skill bytes require the reported host action. Never put credential values in JSON, command arguments, skill contents or reports.

Library configured job acceptance saves immutable policy/provenance and skill pins. Its dispatch gate refreshes policy and prerequisites and blocks changed policy or legacy jobs without snapshots. Service dispatch, hook execution and actual agent launch remain unavailable. Do not bypass a block by removing a required hook, editing permission controls, or accepting a new job without host authorization.

## Planned capabilities

The stage remains `foundation`. Initialization, agent delegation, service dispatch/recovery, GitHub workflows, and automatic review are not implemented commands. Report missing capabilities rather than inventing commands or treating unknown commands as accepted work.

As those operations arrive, use commit-specific results and explicit automation policy. A pushed PR or idle agent alone is not proof of completion or authorization for another action.
