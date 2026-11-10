---
name: astack-cli
description: Use the astack CLI to register projects, manage owned worktrees, inspect project configuration and the local service queue, reconcile explicit Herdr layouts, control verified interactive Codex workers, delegate work to project-defined agents, inspect durable runs/events, explicitly resume/cancel, or discover installed orchestration capabilities before delegation.
---

# Using astack

## Discover capabilities

`astack --skill` prints this installed guide as Markdown with skill frontmatter. Invoke it without a subcommand. Use `astack --help` and command-specific `--help` for argument syntax. Help and command JSON remain available separately.

From the astack source repository use `pnpm dev` instead of `astack`; after building use `pnpm start`. An installed binary resolves this guide independently of cwd.

For generic delegation, run `astack agents list` and `astack handoff submit --agent <name> --task '<task>'`. Supply `--issue <number>` or `--pr <number>` for GitHub context, with optional `--repo` and `--host` overrides; `--base <full-sha>` chooses the checkout commit and `--base pr-head` selects the attached PR's head. The project is inferred inside a registered checkout. The service queues work and runs it independently. Inspect with `astack run inspect <id>` when needed; a worker records its result using `astack run finish <id> --status completed|needs-input|failed --summary '<result>'` and can attach files with `--artifact <relative-path>`. Workflows connecting handoffs are not implemented.

## Focused roles and user setup

`astack skills show orchestrator`, `astack skills show implementer` and `astack skills show reviewer` print narrower SKILL.md guides. Workers consume an explicit assignment and return proposals; the orchestrator chooses host follow-ups. Installation never grants worker publication/cleanup authority or changes saved runtime prompts.

`astack skills list --json` shows packaged versions/digests. `astack skills inspect --json` reports availability without creating files. Explicit `astack skills install --json` installs all three at `$CODEX_HOME/skills` or `~/.codex/skills`; select `--root <directory>` for another user/profile skills root and repeat `--role <orchestrator|implementer|reviewer>` to select roles. The root must exist or have a trusted existing immediate parent. Authored, edited, deleted-owned, foreign and pending targets are preserved; there is no force/adopt option. Versions/digests and owners are recorded through managed-file metadata. The global `--skill` still prints this command guide; role filtering uses `--role`.

A blocked installation can preserve existing files; pending means publication may have partially completed. Inspect the exact root/role and retain its journal rather than deleting claims or retrying by age. No agent settings/project files are rewritten, and repository context is not needed. Automatic role binding remains later work. See the packaged role guides for assignment-specific instructions; source contributors can consult `docs/skills.md` for installation/recovery contracts.

## Commands available now

| Command                                                                                           | Result                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `astack --skill`                                                                                  | Installed agent guide                                                                       |
| `astack --help` / `--version`                                                                     | Command discovery / version                                                                 |
| `astack info [--json]`                                                                            | Package information; not project/job status                                                 |
| `astack agents list [--project <id>] [--json]`                                                    | List project-defined agent names and descriptions                                           |
| `astack handoff submit --agent <name> [--task <text>]`                                            | Queue generic work with optional GitHub context                                             |
| `astack run finish <id> --status <status> --summary <text>`                                       | Record a generic agent result                                                               |
| `astack project register [path] [--id <project-id>] [--json]`                                     | Deliberately register a canonical checkout in local state; default path is caller directory |
| `astack project list [--limit <count>] [--after <project-id>] [--json]`                           | Paginated recorded project identities and primary checkout paths                            |
| `astack context [selectors] [--json]`                                                             | Inspect target identity, selection source, Git state, and readiness                         |
| `astack doctor --project <id> [--role <name>] [--json]`                                           | Check project identity, configuration, and prerequisites                                    |
| `astack config-schema`                                                                            | Print the project configuration JSON Schema                                                 |
| `astack service run [--capacity <count>] [--role-capacity <count>]`                               | Foreground local coordinator; Codex is available when installed                             |
| `astack service status / wake [--json]`                                                           | Live coordinator evidence / request a reconciliation pass                                   |
| `astack service submit <required options> [--json]`                                               | Persist configured intent, attempt and pending effect atomically                            |
| `astack service inspect <job-id> [--json]`                                                        | Read saved job evidence, also when service is offline                                       |
| `astack errors list [--limit <count>] [--json]` / `errors inspect <id> [--json]`                  | Read recorded service errors and worker failures                                            |
| `astack herdr configure / ensure / inspect --project <id> [--json]`                               | Explicit host target and persistent primary project space                                   |
| `astack herdr worker prepare / inspect --attempt <id> [--json]`                                   | Grouped owned checkout layout and current attribution                                       |
| `astack herdr worker bind-agent --attempt <id> --kind <kind> [--json]`                            | Record an already detected matching agent; never launch it                                  |
| `astack herdr reconcile <id> --operation <id> --writer-stopped [--json]`                          | Settle pending layout evidence after trusted writer quiescence                              |
| `astack worktree prepare --project <id> --key <key> --branch <branch> --base <full-sha> [--json]` | Prepare or verify an owned isolated checkout                                                |
| `astack worktree inspect <id> [--json]`                                                           | Observe ownership, phase, and Git evidence                                                  |
| `astack worktree remove <id> [--json]`                                                            | Remove a verified clean owned checkout; preserve its branch                                 |
| `astack worktree reconcile <id> --operation <id> --writer-stopped [--json]`                       | Settle interrupted state after trusted host quiescence confirmation                         |
| `astack run reconcile-queue <job-id> --writers-stopped [--json]`                                  | Recover stopped preparation before any worktree intent was recorded                         |
| `astack runtime capabilities`                                                                     | Supported interactive controls and explicit provider limits                                 |
| `astack runtime inspect --attempt <id> [--json]`                                                  | Read saved worker identity and current liveness                                             |
| `astack runtime reconcile --attempt <id> [--json]`                                                | Bind a matching pending launch without another provider write                               |
| `astack runtime input --attempt <id> --key <key> [--json]`                                        | Submit bounded stdin text once under refreshed policy                                       |
| `astack runtime interrupt --attempt <id> --key <key> [--json]`                                    | Request Escape once; not task cancellation or shutdown                                      |
| `astack run inspect / report <job-id> [options]`                                                  | Recover saved state / validate a host-supplied proposal                                     |
| `astack run respond / resume / cancel <job-id> [options]`                                         | Save decisions and explicitly control the same worker                                       |
| `astack run events [options]`                                                                     | Read/wait on durable local events without acknowledging them                                |
| `astack run cursor inspect / ack <consumer> [options]`                                            | Read or CAS-acknowledge a scope-specific consumer cursor                                    |

Global `--state-directory <path>` selects isolated host state. `--git-executable <absolute-path>` selects trusted Git; otherwise the CLI searches absolute host PATH entries. Git inspection requires Git 2.45 or later.

Context selectors are `--project <project-id>`, `--checkout <checkout-id>`, `--run <attempt-id>`, and `--path <path>`.

## Select the intended target

- From a neutral directory or another project, use an explicit project ID, checkout ID, or path. `project list` supplies saved IDs; listed paths are recorded facts and can be stale.
- Without selectors, context inspects the nearest Git repository from caller cwd. A collection directory never causes child-project discovery or guessing.
- An explicit project selects its primary checkout unless an explicit path selects another checkout belonging to that project. An explicit checkout selects that checkout.
- A saved attempt binds its project/repository/checkout. Other explicit selectors must agree. `--run` uses an existing persisted attempt ID; handoff submission creates durable runs. Saved assignment commits and observed HEAD are separate facts.
- Explicit targets override ambient cwd. An explicit `--path` is an assertion and must agree with other explicit selectors. Conflicts reject rather than falling back.

Context can inspect an unregistered repository without registering it or creating state. Register only when the user intends to establish a local project identity. Registration creates no project config, skills, worktrees, or execution policy. A linked checkout needs deliberate registration; it then shares project identity while keeping its own checkout ID. Independent clones and duplicate basenames remain separate.

Moved/replaced registrations reject as stale. Do not bypass this by silently selecting another checkout, changing IDs, or treating matching remotes as ownership. Relocation/reconciliation is not implemented yet.

## Interpret results

Read commands emit `{ schemaVersion: 1, outcome: 'completed', value: ... }` or `rejected` with a stable error code. Registration emits `persisted` with `disposition` and identities, `rejected`, or `uncertain`. A completed read is an observation; persisted registration is local identity evidence. Neither means an agent job was accepted.

After `uncertain`, inspect the registry and supplied identities before retrying persistence. No provider effect or automatic retry is implied. Missing state permits empty-registry diagnostics; unsafe/corrupt/incompatible state remains an error. Read-only commands do not migrate old schemas; deliberate registration or an explicit library read-write open can migrate them.

Context reports Git readiness while provider and configuration checks remain `not_checked`. Doctor additionally checks the selected agent configuration for registered projects. Do not interpret registration or a clean checkout as execution authorization.

## Owned worktrees

Preparation requires a registered project, stable owner key, new task branch, and full local commit SHA. Optional `--checkout` selects a registered source and `--run` binds an existing saved attempt; branch/base must match that assignment. Existing branches are not adopted. Managed checkouts live in private containers under host state, and receive separate registered checkout IDs. Repeated prepare verifies/reuses the same resource; a pending reservation never launches a second writer.

Worktree outcomes include `prepared`, `reused`, `removed`, `reconciled`, `inspected`, `blocked`, and `pending`. Inspecting a pending record does not establish readiness. Routine removal preserves dirty, untracked, and ignored files, edited ownership markers, changed identities/branches, locked resources, and task branches. Attempt-bound cleanup also requires a terminal result and release of other retained resources. Host/runtime callers must independently establish that workers/services stopped.

After interruption, inspect the record and exact operation ID. Use `--writer-stopped` only after the trusted host/operator has verified the original writer and its children stopped. The flag is an attestation, not an automatic process check. Never infer it from PID absence, age, agent idleness, or a worker/PR assertion. Reconcile reads provider/filesystem evidence and settles state without repeating Git creation/removal. Unmarked containers and branch-only partial creation remain preserved; no force, branch deletion, or automatic repair is available.

Worktree creation currently rejects configured content-filter commands and sparse checkout until execution profiles support them. LFS/submodule initialization and automatic provisioning remain later capabilities; runtime launch is separate from worktree preparation. Do not bypass a blocked/pending outcome by choosing a different directory or forcing Git cleanup.

## Project agent configuration

Use `astack doctor --project <id> [--checkout <id>] [--role implementer] [--json]`. It reads existing state and reports effective settings, leaf provenance, and actionable prerequisites. Exit 1 means blocked or rejected; readiness launches no command and grants no durable execution capability.

Project settings live in `.astack/config.json` in the registered primary checkout. Fill the file deliberately; Astack reads its current contents directly. Accepted jobs retain their private saved configuration; later edits apply to new jobs. Job inspection does not print saved command arguments. Legacy host policy and approval files are not read.

The starter has `agents` entries for implementer and reviewer. Fill in each agent's `provider`, `model` and `reasoning`; `instructions` is optional and becomes part of its assignment. `permissions.files` is `readonly` or `write`. Run `astack config-schema` to inspect all valid project settings. New jobs save the current settings. The built-in Codex provider uses Herdr and supplies launch arguments. Per-agent `hooks.before` and `hooks.after` are optional shell command strings. The service runs them before worker launch and after a completed, failed or cancelled task; `needs_decision` keeps the environment. Inspect hook outcomes with `run inspect`. Agent `ports` entries accept `{range:[first,last]}` or `{fixed:port}`; names become environment variables for hooks and the Codex worker. All projects sharing state coordinate assignments; unrelated applications are not probed. Never put credentials in JSON, command arguments, instructions or reports.

Configuration inspection is read-only. The service owns dispatch and selects the runtime from the accepted job configuration. Hooks remain explicit operations. Missing prerequisites or unavailable runtimes are reported rather than silently ignored.

## Local service and durable queue

Handoff submission and run operations start the service if needed. Use `astack service run [--capacity <count>] [--role-capacity <count>]` to run it in the foreground. Use `service status --json` for live readiness/counts and `service inspect <job-id> --json` for saved job/attempt/effect evidence, including offline. `service wake` requests reconciliation after a meaningful external change; it does not clear unknown claims or grant permissions.

`service submit --project <id> [--checkout <id>] --role <name> --key <stable-key> --branch <branch> --commit <full-sha> --task '<description>' --json` persists generic delegation intent. Prepare/select the intended registered checkout explicitly. Submission creates no worktree. A receipt is durable intent, not agent start. Retry a lost acknowledgment with the same key; changed assignment/task/policy under that key conflicts. Never submit replacement work with a new key merely because the client disconnected.

The CLI makes the built-in `codex-herdr` runtime available when Codex and Herdr are found at service startup; restart the service if they were installed later. Herdr resolves Codex in its own server environment; the host executable option does not force that path in Herdr. Each project agent selects the Codex provider, model and reasoning; Astack supplies the command. Do not substitute a worker merely to bypass a block.

Use `astack service stop` to stop the coordinator gracefully. It does not stop Herdr agents or establish worker shutdown. A later submission starts the service again.

Host-wide worker capacity defaults to four globally and four per agent type. Configure it in `~/.astack/service.json`, for example `{ "concurrency": { "global": 6, "perAgent": 3 } }`, and restart the service to apply changes. Handoffs wait without a worktree until capacity is reserved.

Use `astack errors list --json` for recent service errors, worker-dispatch blockers, uncertain worker observations and failed reports, and `astack errors inspect <id> --json` for a record. Errors before a request reaches the service are reported to the caller and are not included.

One coordinator owns each private state directory through a kernel-backed lock. Other instances reject. SIGINT/SIGTERM drain foreground work and release the coordinator; they do not prove existing workers stopped. On restart, claimed launches are inspected without replaying them. Unknown launches retain capacity despite claim expiry. Only trusted runtime evidence can establish launch absence or quiescence. `awaiting_result` means a known worker stopped, not that the task succeeded.

Transport is a private Unix socket with same-host-user authority, not a TCP service or restricted worker-report endpoint. Use a short private state path if socket length is rejected. Preserve edited/unowned endpoint files and obtain host inspection; do not remove sockets, steal locks or force cleanup as an automatic repair. Runtime events, submissions, startup and explicit wake drive reconciliation; there is no recurring GitHub polling loop.

## Herdr project and worker layouts

Use `herdr configure --project <id> [--session default] [--socket <path>] [--label <text>]` to save an explicit host target without contacting Herdr. The shared default session is deliberate; use a named session only for an explicit isolation preference. `herdr ensure --project <id>` associates or creates one primary space without focus changes. `herdr inspect --project <id>` reads current evidence. Global `--herdr-executable <absolute-path>` selects trusted CLI code. Only installed protocol 22 is supported initially.

`herdr worker prepare --attempt <id>` opens an existing Astack-owned ready worktree in its saved project's primary group. It requires a saved attempt, valid accepted policy, exact initial branch/SHA, intact ownership and fresh registry identity. It creates no Git checkout and starts no agent. Existing unowned worker layouts block. The runtime consumes the saved expected agent name/pane.

`herdr worker inspect --attempt <id>` verifies current layout/attribution. `herdr worker bind-agent --attempt <id> --kind <kind>` records only an already detected matching agent, including actual foreground cwd, terminal and available native session ID. It launches nothing. Provider idle/done status is not task success or permission for another writer.

Targets always come from saved project settings, never caller cwd, `HERDR_*` pane variables or UI focus. Labels are presentation. A changed endpoint, moved pane, wrong cwd, replacement terminal/session or missing worker layout blocks; do not redirect old IDs or create replacement agents. Primary project spaces remain open, and worker resources are retained for later cleanup.

After an uncertain write, inspect its space/operation IDs. `herdr reconcile <id> --operation <id> --writer-stopped` only settles fresh matching evidence after trusted host confirmation that the original writer/children stopped and no late write can arrive. Never infer that from a timeout or idle agent. Reconciliation never repeats creation/opening; absent or changed evidence remains blocked. There is no force, close-group, automatic adoption, Herdr update, or fallback runtime repair.

## Interactive Codex controls

`runtime capabilities` prints supported controls without contacting state/providers. `runtime inspect --attempt <id> [--json]` reads saved intent and fresh identity. `runtime reconcile --attempt <id>` can bind a fully matching pending launch without repeating it. Launch happens through the capacity-owning service. Generic handoffs receive their task and configured instructions through deterministic initial input.

Herdr owns execution. A project agent selects `provider: codex`, a model and reasoning. Astack supplies the native sandbox, approval, no-daemon and no-alt-screen flags, the fixed update-prompt suppression and exact checkout. Agent file permissions select workspace-write or read-only. Identity checks, saved launch intent and no-replay recovery remain in force.

`runtime input --attempt <id> --key <stable-key> [--codex-executable <approved-path>] [--json]` reads at most 16 KiB of UTF-8 from stdin; it accepts idle/done sessions and rejects approval dialogs, active/unknown UI and terminal control characters. Input is not echoed or saved; only its digest/key/acknowledgement are persisted. Herdr receives text in process argv, so do not include credentials. `runtime interrupt --attempt <id> --key <stable-key> ...` requests Escape; it does not establish cancellation or stopped descendants. Approval/question UIs require deliberate operator handling.

Each new control verifies saved project/checkout ownership, branch, endpoint, workspace/pane/terminal, foreground cwd and unique attempt name/kind. Input/interrupt target that name. Native session IDs are optional at binding; a captured ID must remain present and unchanged. Metadata first appearing later does not change a binding established without an ID. Missing/changed required evidence blocks; no fallback or replacement agent is launched. One trusted controller per worker and no reuse of reserved names are host preconditions: Herdr cannot atomically compare worker identity with a write or prove server executable resolution.

Repeated keys return the saved receipt/current observation; changed text/kind conflicts. A pending launch is never launched again. A pending input/interrupt blocks subsequent controls because UI state cannot prove delivery. Reconcile does not clear unknown delivery or absent launches; do not edit state, change keys, or start another worker to bypass uncertainty. Abort/timeout/service exit do not prove Herdr or Codex stopped. Idle/done and Escape acknowledge neither an accepted task result nor free capacity; explicit run operations handle report acceptance and cancellation separately.

## Planned capabilities

The stage remains `foundation`. Automatic handoffs/report harvesting, runtime wake-up and automatic review-result publication are not implemented. Report missing capabilities rather than inventing commands or treating unknown commands as accepted work.

As those operations arrive, use commit-specific results and explicit automation policy. A pushed PR or idle agent alone is not proof of completion or authorization for another action.

## Durable run outcomes and controls

Use `astack run inspect <job-id> [--json]` to recover assignment, current report/control, worker status, latest responses/continuations and retained cleanup offline. Task outcome and worker liveness are separate; a completed result with a running/unknown worker still retains capacity. Never infer cleanup permission from an accepted report, cancellation request, idle pane or empty resource summary.

`astack run report <job-id> --key <stable-key> (--file <JSON-path> | --stdin) [--json]` asks the coordinator to validate and record a worker proposal. The file is the original versioned report or `{proposal, artifacts}` with bounded relative path/digest/size references. Supply exact saved IDs and commit evidence. A parsed report is not proof of origin or business correctness; never feed arbitrary terminal text into acceptance. The operation checks acknowledged prompt bytes, owned checkout/branch/full SHA, clean completed work, review target/base/gate provenance and artifact bytes. Accepted report retries with the same key return saved evidence; changed input conflicts. Reports never release resources automatically.

For a needs_decision report, use `run respond <job-id> --key <key> --decision <report-id> --text <response>` to save a response without sending input. Then explicitly use `run resume <job-id> --key <key> --response <response-id>`. Resume creates a durable continuation of the same verified worker, with fresh ownership/review gates and keyed input; later project configuration changes do not alone block it. It never starts a replacement agent or changes execution policy. Pending/unknown input is not replayable; do not invent a new key to bypass uncertainty. An acknowledged continuation allows a later report, not accepted task completion. Approval/question UI handling remains deliberate operator work.

`run cancel <job-id> --key <key> [--interrupt]` saves intent before optional keyed Escape to a verified owned worker. It blocks future claims and launch/input. Never-claimed/proved-stopped jobs become cancelled; running/unknown jobs remain cancel_requested until trusted shutdown evidence. Escape acknowledgement is not shutdown. Use a separate explicit key to request interrupt later after an intent-only request. Existing terminal outcomes remain preserved. Worktrees, branches, user changes and uncertain resources remain retained.

`run events [--project <id>] [--job <id>] [--after <event-id> | --consumer <id>] [--limit <1–100>] [--wait <0–20000>] [--json]` reads/waits on local SQLite events. It neither polls GitHub nor injects worker prompts, and works independently of the service/pane. Process the page before explicitly acknowledging its `nextCursor` with `run cursor ack <consumer> --expected <old-offset> --after <nextCursor>` using exactly the same project/job scope. `run cursor inspect <consumer>` reads a saved offset. Reading and disconnects never advance cursors; replay is expected, exactly-once processing is not promised. Stale CAS updates, rewinds and future offsets reject.

Report/decision mutations use the live owning service; read commands work offline against existing migrated state. Keep credentials out of reports, response text and artifacts. Event records contain IDs/state/references, never arbitrary transcripts or response text. Automatic report discovery, orchestrator wake-up, shutdown and remedial actions remain planned.

## Host-authorized input recovery

`runtime authorize-input-retry --attempt <id> --key <input-key> --digest <sha256> --generation <number> --not-submitted --writer-stopped [--codex-executable <approved-path>] [--json]` is an explicit trusted host attestation after independent proof of non-delivery. Stop the coordinator and all original input controllers/descendants first; the CLI takes the coordinator lock. Never supply these flags from a timeout, idle screen, PID absence, parser reproduction alone, or worker proposal. The flags do not verify their own truth.

The operation checks the active assignment, current accepted policy and owned ready worker. It atomically archives the exact pending input generation and authorizes future retry of the same key/digest without sending input. Restart/wake the coordinator for workflow delivery, or explicitly supply the same runtime input. New actions have a newer generation; repeat authorization of an older generation cannot clear a newer send, and old acknowledgements cannot settle it. No new worker, capacity release, shutdown or cleanup is authorized. Other uncertain actions stay blocked.

## Explicit report collection and shutdown reconciliation

`astack run collect-report <job-id> --key <report-key> --session-file /absolute/path/to/rollout.jsonl [--json]` collects a final JSON report from one explicitly selected local Codex session and sends it through normal coordinator acceptance. It requires a saved ready runtime binding, matching metadata and exact saved assignment text, and the latest typed final response after the latest user message. It never searches other sessions or scrapes terminal output. Malformed reports reject; request a corrected report from the same worker if needed. `run report --file` and `run report --stdin` accept reports from workers or the host. New manual reviews use prompt version 3 with an object snapshot and numeric finding-line example. Finding line numbers must be positive JSON integers, not strings; workers submit their own report using the assigned CLI command.

After independently establishing that the exact worker and all descendants, attempt services and original effect writers have stopped, close only its owned worker workspace and stop the coordinator. Run `astack run reconcile <job-id> --key <key> --attempt <attempt-id> --launch <launch-id> --revision <control-revision> --worker-stopped --services-stopped --writers-stopped [--herdr-executable /absolute/path] [--json]`. These flags record truthful host attestations, never facts inferred from idle/done, Escape, missing panes or PID absence alone. Do not close the primary project workspace or reuse reserved names.

The offline command holds coordinator ownership and freshly verifies absence on the same saved Herdr server. It rejects stale bindings/revisions, pending actions, unresolved continuations and unknown retained resources. One transaction records host evidence, releases only exact bound worker/runtime/Herdr holds and frees capacity on restart; accepted task outcomes remain intact. Repeating the exact request returns its saved evidence. `cleanup.state=reconciled` is not checkout deletion; `retainedResourceCount` shows remaining holds and `resourceCount` includes historical records. Use normal `worktree remove` separately when ownership and cleanliness permit. No force deletion or branch removal is authorized.

## Durable cleanup and retention

Use `cleanup request <job-id> --key <stable-key> --not-before <unix-ms> [--automatic] [--allow-unpublished] --json` after a terminal run on a dedicated ready owned checkout. Default retention also requires confirmed publication. Request and control commands work offline under coordinator ownership or through the running service. `cleanup inspect <job-id> --json` reads the frozen assignment, retention, phase, reason and revision without provider calls. One immutable request per run prevents bypass keys. No historical runs are enrolled automatically.

With the service stopped, `cleanup execute <job-id> --revision <cleanup-revision> --json` performs fresh checks and ordinary owned worktree removal. Worker resources must already be shutdown-reconciled. Alternatively supply all of `--attempt <id> --launch <id> --run-revision <n> --shutdown-key <key> --worker-stopped --services-stopped --writers-stopped` together, after obtaining independent host shutdown evidence. The flags are attestations, not requests to stop processes. Never derive them from idle/done, age, Escape or missing PIDs. Cleanup never kills workers/services, closes Herdr layouts or releases unknown holds.

Automatic removal requires both the saved `--automatic` request and `service run --cleanup`. It waits for retention and verified shutdown, using local wakes and retention timers without GitHub polling. Service startup without the flag suspends eligible backlog, and automatic requests received while disabled are saved suspended. Restoring the flag does not resume them. `cleanup suspend|resume|cancel <job-id> --revision <cleanup-revision> --json` controls unstarted plans; suspend retains resources indefinitely. Requests/deadlines cannot be replaced with a new key. Use a new dedicated checkout for another delegated task.

A persisted `blocked` plan preserves its checkout and states the blocker. `started` after interruption means uncertain cleanup, not successful removal: never retry it automatically. Stop/exclude the original cleanup writer and its children, then use offline `cleanup reconcile <job-id> --revision <started-revision> --writers-stopped --json`. It inspects/reconciles the exact owned worktree operation without replaying Git removal. It either verifies absence and completes, or restores a request for a separately authorized execution. Dirty/untracked/ignored/unowned resources remain preserved. Branches, primary spaces, marker containers, historical reports and registrations remain. Review can proceed while cleanup is blocked. See `docs/cleanup.md` and ADR 0020.

For a task cancelled before any worker launch claim, `run cancel` now closes its exact unclaimed initial launch and resolves the cancelled attempt locally, keeping `entry.claim` null. A local effect-resolution claim does not indicate a worker started. If an older never-launched cancellation blocks cleanup with `resource_in_use`, repeat the original `run cancel <job-id> --key <same-key>` with the service running. The first eligible settlement appends one cancellation event; reads/startup never heal it. Claimed, unknown or additional effects do not qualify and never become shutdown evidence.

## Initialize one project

Use `astack init <path> --dry-run --json` before setup. A repository subdirectory resolves to its root; a neutral directory requires an explicit path or `--project <id>` / `--checkout <id>`. Selectors must agree. The project ID defaults to the repository directory name; `--id <id>` overrides it or asserts the selected saved identity. Register the primary before initializing a linked checkout. Owned task checkouts are refused.

Apply with `astack init <path> --json`. A running local service handles initialization without stopping workers. Optional `--with-skills` installs all catalog skills in `.agents/skills`, with Git-compatible mode 0644; new general-purpose catalog skills are included. Standalone `skills inspect|install --root <project>/.agents/skills --project-scope` uses the same mode. Global skill availability is read-only; select its inspection root with `--user-skills-root <path>`. Missing global guidance is not permission to install it.

Commit and push project skills, instructions and other setup before delegation so they exist in the Git commit selected for the worker worktree. Init's project configuration is read separately from the primary checkout. Init reports skill results and Herdr errors; a dry run reports workspace availability as not checked. Its readiness does not check whether the service is running.

Initialization creates an incomplete `.astack/config.json` starter only where safe; it stores no second copy of project configuration on the host. It preserves authored/edited files, existing instructions, scripts and environment files. Old host configuration is left untouched and is not read. It never installs dependencies, runs scripts, launches agents or enables automatic review. Inspect the project yourself and fill its project configuration; initialization does not discover project tools. Configured before and after hooks run automatically around worker execution.

Init ensures a primary Herdr workspace by name, using saved target settings or the standard default session/socket. `--herdr-session <session> --herdr-socket <path>` selects a different target and `--herdr-label <name>` selects its name. A matching name is reused regardless of cwd; otherwise a workspace is created. The result reports created/reused and the workspace handle. It never starts an agent. Preview does not contact Herdr.

`previewed` and `initialized` do not mean delegation is ready. Inspect configuration diagnostics and configure project settings, prerequisites and the service runtime. Astack prepares each task checkout during submission. `partial` preserves successful registration/files/provider intent. Repeat only known completed stages; pending managed-file/provider writers remain pending and require their explicit recovery contracts. Never remove journals to unblock setup, and never commit pending/stage files even if an authored ignore file does not hide them. Apply runs under coordinator ownership or through the running service; preview remains read-only.

## Shared host resource reservations

Use `astack resources reserve --file <request.json> --json` for one port or service/container/cache name bound to an exact accepted implementation `jobId`, `attemptId` and stable `key`. All projects must use the same host state directory. A port spec is `{kind:"port",protocol:"tcp",host:"127.0.0.1",candidates:[43100,43101]}`; one candidate is fixed. For database-only coordination use `{kind:"managed-port",protocol:"tcp",host:"127.0.0.1",range:[20000,29999]}`; the OS is not probed and other applications may occupy the port. A name spec is `{kind:"name",namespace:"container",prefix:"worker",fixed:false}`. Reserve/read never launch services or edit authored environment files. For automatic worker setup, declare agent ports and before/after hooks in the project configuration. Legacy review resource requests are unsupported.

`resources inspect <id> --json` and `resources list --project <id> --after <id> --limit 50 --json` are read-only. Mutations `reserve|start|running|retain|release --file <request.json> --json` use bounded regular JSON files and require the coordinator stopped/excluded; they never bypass its ownership lock. Requests include `schemaVersion:1`.

`start` requires `id,expectedRevision,key,controller`; only a newly persisted updated startup receipt can be used once within separately approved host execution. Existing receipts are historical evidence, never permission to launch again. A database reservation is not an OS socket reservation. Known busy candidates can advance only before startup; unknown/starting resources stay retained. `running` adds `ownedEndpointVerified:true` and requires independent host ownership/application-readiness evidence for that exact receipt; an occupied port alone is insufficient. `retain` needs `id,expectedRevision` and holds reservations indefinitely.

`release` needs `id,expectedRevision,key,startupKey,writersStopped:true,servicesStopped:true`. The host independently stops/verifies services and excludes original startup controllers/children before asserting these flags. `startupKey` matches the saved startup key, or is null only when never started. Ports additionally require fresh free-bind evidence; busy/unknown endpoints remain held. Generic cleanup cannot bypass allocator holds. Release allocations first, then reconcile native workers and remove owned worktrees separately. Never infer shutdown from age, PID absence, cancellation, worker reports or idle panes; never delete records or kill unrelated listeners to free a reservation.

## Agent lifecycle hooks

Optional per-agent `hooks.before` and `hooks.after` are shell command strings. The local service runs them before the worker and after terminal outcomes, keeping the environment for `needs_decision`. Inspect outcomes and `hook_changed` events; a failed or unknown invocation is not automatically retried.
