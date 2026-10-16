---
name: astack-cli
description: Use the astack CLI to register checkouts, inspect project context, or discover installed orchestration capabilities. Read supported commands before attempting delegation.
---

# Using astack

## Discover capabilities

`astack --skill` prints this installed guide as Markdown with skill frontmatter. Invoke it without a subcommand. Use `astack --help` and command-specific `--help` for argument syntax. Help and command JSON remain available separately.

From the astack source repository use `pnpm dev` instead of `astack`; after building use `pnpm start`. An installed binary resolves this guide independently of cwd.

## Commands available now

| Command                                                                 | Result                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `astack --skill`                                                        | Installed agent guide                                                                       |
| `astack --help` / `--version`                                           | Command discovery / version                                                                 |
| `astack info [--json]`                                                  | Package information; not project/job status                                                 |
| `astack project register [path] [--id <project-id>] [--json]`           | Deliberately register a canonical checkout in local state; default path is caller directory |
| `astack project list [--limit <count>] [--after <project-id>] [--json]` | Paginated recorded project identities and primary checkout paths                            |
| `astack context [selectors] [--json]`                                   | Inspect target identity, selection source, Git state, and readiness                         |
| `astack doctor [selectors] [--json]`                                    | Alias for `context`                                                                         |

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

Doctor currently reports Git readiness, other providers as `not_checked`, configuration provenance as `none`/`not_implemented`, and delegation as unavailable. Do not interpret registration or a clean checkout as execution authorization.

## Planned capabilities

The stage remains `foundation`. Initialization, managed worktree lifecycle, trusted project/role configuration, agent delegation, service dispatch/recovery, GitHub workflows, and automatic review are not implemented commands. Report missing capabilities rather than inventing commands or treating unknown commands as accepted work.

As those operations arrive, use commit-specific results and explicit automation policy. A pushed PR or idle agent alone is not proof of completion or authorization for another action.
