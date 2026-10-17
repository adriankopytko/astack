---
name: astack-cli
description: Use the astack CLI to register projects, manage owned worktrees, inspect approved configuration and the local service queue, reconcile explicit Herdr layouts, control verified interactive Codex workers, or discover installed orchestration capabilities before delegation.
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
| `astack service run [--codex-herdr] [--capacity <count>] [--role-capacity <count>]`               | Foreground local coordinator; opt-in codex-herdr runtime                                    |
| `astack service status / wake [--json]`                                                           | Live coordinator evidence / request a reconciliation pass                                   |
| `astack service submit <required options> [--json]`                                               | Persist configured intent, attempt and pending effect atomically                            |
| `astack service inspect <job-id> [--json]`                                                        | Read saved job evidence, also when service is offline                                       |
| `astack herdr configure / ensure / inspect --project <id> [--json]`                               | Explicit host target and persistent primary project space                                   |
| `astack herdr worker prepare / inspect --attempt <id> [--json]`                                   | Grouped owned checkout layout and current attribution                                       |
| `astack herdr worker bind-agent --attempt <id> --kind <kind> [--json]`                            | Record an already detected matching agent; never launch it                                  |
| `astack herdr reconcile <id> --operation <id> --writer-stopped [--json]`                          | Settle pending layout evidence after trusted writer quiescence                              |
| `astack worktree prepare --project <id> --key <key> --branch <branch> --base <full-sha> [--json]` | Prepare or verify an owned isolated checkout                                                |
| `astack worktree inspect <id> [--json]`                                                           | Observe ownership, phase, and Git evidence                                                  |
| `astack worktree remove <id> [--json]`                                                            | Remove a verified clean owned checkout; preserve its branch                                 |
| `astack worktree reconcile <id> --operation <id> --writer-stopped [--json]`                       | Settle interrupted state after trusted host quiescence confirmation                         |
| `astack runtime capabilities`                                                                     | Supported interactive controls and explicit provider limits                                 |
| `astack runtime inspect --attempt <id> [--json]`                                                  | Read saved worker/native-session identity and current liveness                              |
| `astack runtime reconcile --attempt <id> [--json]`                                                | Bind a matching pending launch without another provider write                               |
| `astack runtime input --attempt <id> --key <key> [--json]`                                        | Submit bounded stdin text once under refreshed policy                                       |
| `astack runtime interrupt --attempt <id> --key <key> [--json]`                                    | Request Escape once; not task cancellation or shutdown                                      |

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

Worktree creation currently rejects configured content-filter commands and sparse checkout until execution profiles support them. Project provisioning, LFS/submodule initialization and hooks remain later capabilities; runtime launch is separate from worktree preparation. Do not bypass a blocked/pending outcome by choosing a different directory or forcing Git cleanup.

## Approved project and role configuration

Use `astack config inspect --project <id> [--checkout <id>] [--role implementer] [--json]` (alias `config check`). It reads existing state and reports effective settings, leaf provenance, pinned skill versions/digests, and actionable prerequisites. Exit 1 means blocked or rejected; readiness launches no command and grants no durable execution capability.

Portable `.astack/project.json` is a proposal. The trusted host/operator maintains `<state-directory>/config/<project-id>.json` outside repositories with private directory/file permissions. Registration does not create or approve it. Do not copy a worker/PR proposal into this file as an automatic repair. Review and approval belong to the host/operator; there is no approval/init command yet.

Settings resolve defaults → user → approved project → local → request. Objects merge by fields; arrays replace completely. Host-only permissions, timeout limits and mandatory hooks apply after merging. A changed proposal blocks until reviewed; it never grants new permissions. Missing executables, approved environment names or exact protected skill bytes require the reported host action. Never put credential values in JSON, command arguments, skill contents or reports.

Library configured job acceptance saves immutable policy/provenance and skill pins. Its dispatch gate refreshes policy and prerequisites and blocks changed policy or legacy jobs without snapshots. Generic service dispatch is available through injected runtimes. Hook execution remains unavailable. Interactive agent launch requires the explicit codex-herdr service opt-in and supported role configuration. Do not bypass a block by removing a required hook, editing permission controls, or accepting a new job without host authorization.

## Local service and durable queue

Run `astack service run [--codex-herdr] [--capacity <count>] [--role-capacity <count>]` in the foreground with explicit host state. Use `service status --json` for live readiness/counts and `service inspect <job-id> --json` for saved job/attempt/effect evidence, including offline. `service wake` requests reconciliation after a meaningful external change; it does not clear unknown claims or grant permissions.

`service submit --project <id> [--checkout <id>] --role <name> --key <stable-key> --branch <branch> --commit <full-sha> --task '<description>' --json` persists generic delegation intent. Prepare/select the intended registered checkout explicitly. Submission creates no worktree. A receipt is durable intent, not agent start. Retry a lost acknowledgment with the same key; changed assignment/task/policy under that key conflicts. Never submit replacement work with a new key merely because the client disconnected.

The built-in `codex-herdr` runtime is enabled only with `service run --codex-herdr [--codex-executable <approved-absolute-path>]`. Configured executables alone do not register a runtime. This host opt-in accepts the configured local servers’ shell, inherited environment, canonical Codex resolution and ambient native configuration. Each project role still needs an unchanged enabled host policy selecting this runtime and approved command. Do not enable execution or substitute a worker merely to bypass a block.

One coordinator owns each private state directory through a kernel-backed lock. Other instances reject. SIGINT/SIGTERM drain foreground work and release the coordinator; they do not prove existing workers stopped. On restart, claimed launches are inspected without replaying them. Unknown launches retain capacity despite claim expiry. Only trusted runtime evidence can establish launch absence or quiescence. `awaiting_result` means a known worker stopped, not that the task succeeded.

Transport is a private Unix socket with same-host-user authority, not a TCP service or restricted worker-report endpoint. Use a short private state path if socket length is rejected. Preserve edited/unowned endpoint files and obtain host inspection; do not remove sockets, steal locks or force cleanup as an automatic repair. Runtime events, submissions, startup and explicit wake drive reconciliation; there is no recurring GitHub polling loop.

## Herdr project and worker layouts

Use `herdr configure --project <id> [--session default] [--socket <path>] [--label <text>]` to save an explicit host target without contacting Herdr. The shared default session is deliberate; use a named session only for an explicit isolation preference. `herdr ensure --project <id>` associates or creates one primary space without focus changes. `herdr inspect --project <id>` reads current evidence. Global `--herdr-executable <absolute-path>` selects trusted CLI code. Only installed protocol 22 is supported initially.

`herdr worker prepare --attempt <id>` opens an existing Astack-owned ready worktree in its saved project's primary group. It requires a saved attempt, valid accepted policy, exact initial branch/SHA, intact ownership and fresh registry identity. It creates no Git checkout and starts no agent. Existing unowned worker layouts block. The runtime consumes the saved expected agent name/pane.

`herdr worker inspect --attempt <id>` verifies current layout/attribution. `herdr worker bind-agent --attempt <id> --kind <kind>` records only an already detected matching agent, including actual foreground cwd, terminal and available native session ID. It launches nothing. Provider idle/done status is not task success or permission for another writer.

Targets always come from saved project settings, never caller cwd, `HERDR_*` pane variables or UI focus. Labels are presentation. A changed endpoint, moved pane, wrong cwd, replacement terminal/session or missing worker layout blocks; do not redirect old IDs or create replacement agents. Primary project spaces remain open, and worker resources are retained for later cleanup.

After an uncertain write, inspect its space/operation IDs. `herdr reconcile <id> --operation <id> --writer-stopped` only settles fresh matching evidence after trusted host confirmation that the original writer/children stopped and no late write can arrive. Never infer that from a timeout or idle agent. Reconciliation never repeats creation/opening; absent or changed evidence remains blocked. There is no force, close-group, automatic adoption, Herdr update, or fallback runtime repair.

## Interactive Codex controls

`runtime capabilities` prints supported controls without contacting state/providers. `runtime inspect --attempt <id> [--json]` reads saved intent and fresh identity. `runtime reconcile --attempt <id>` can bind a fully matching pending launch without repeating it. Launch happens through the capacity-owning service; starting a session does not send the task description.

Herdr owns execution. The host-approved command executable must match the selected canonical Codex path resolved by that server. Native arguments must include each flag once: `--sandbox read-only|workspace-write`, `--ask-for-approval on-request|never`, `--no-daemon`, `--no-alt-screen`. The runtime appends the verified checkout with `--cd`. Other flags, hooks, requested environment/skills and control timeouts below five seconds report missing capabilities. Never drop required configuration to make a blocked launch pass. No headless, model routing, resume or bypass execution is supported.

`runtime input --attempt <id> --key <stable-key> [--codex-executable <approved-path>] [--json]` reads at most 16 KiB of UTF-8 from stdin; it accepts idle/done sessions and rejects approval dialogs, active/unknown UI and terminal control characters. Input is not echoed or saved; only its digest/key/acknowledgement are persisted. Herdr receives text in process argv, so do not include credentials. `runtime interrupt --attempt <id> --key <stable-key> ...` requests Escape; it does not establish cancellation or stopped descendants. Approval/question UIs require deliberate operator handling.

Each new control refreshes accepted policy and verifies saved project/checkout ownership, branch, endpoint, workspace/pane/terminal, foreground cwd, expected name/kind and native session. Missing/changed evidence blocks; no fallback or replacement agent is launched. One trusted controller per worker is a host precondition: Herdr cannot atomically compare native identity with a write or prove server executable resolution.

Repeated keys return the saved receipt/current observation; changed text/kind conflicts. A pending launch is never launched again. A pending input/interrupt blocks subsequent controls because UI state cannot prove delivery. Reconcile does not clear unknown delivery or absent launches; do not edit state, change keys, or start another worker to bypass uncertainty. Abort/timeout/service exit do not prove Herdr or Codex stopped. Idle/done and Escape acknowledge neither an accepted task result nor free capacity; workflow reports/cancellation remain later work.

## Planned capabilities

The stage remains `foundation`. Initialization, workflow-specific implementation/review delegation and handoffs/reports, GitHub workflows, and automatic review are not implemented commands. Report missing capabilities rather than inventing commands or treating unknown commands as accepted work.

As those operations arrive, use commit-specific results and explicit automation policy. A pushed PR or idle agent alone is not proof of completion or authorization for another action.
