# Herdr project spaces and worker layouts

## Implemented scope

Issue #16 adds project-bound Herdr settings, persistent primary project spaces, grouped workspaces for Astack-owned worker checkouts, and verified attribution of already detected agents. It does **not** launch Codex, send prompts, execute project hooks, close workspaces, or register a service worker runtime. Those are separate operations. The separate [interactive runtime](runtime.md) supplies service execution.

The integration was implemented against the installed Herdr 0.9.0 bundled protocol 22 schema (`herdr api schema --json`). The adapter explicitly supports protocol 22 and rejects incompatible snapshots. No live user layouts or agents are needed for default verification.

Herdr documents worktree creation and grouping in its [CLI reference](https://herdr.dev/docs/cli-reference/#worktrees). Its [socket API](https://herdr.dev/docs/socket-api/) describes snapshot fields and scoped runtime identities. The installed schema is the authority for this adapter's supported wire shape; raw diagnostics and unrelated metadata do not become Astack results.

## Commands

```sh
astack herdr configure --project <id> [--label <text>] [--session default] [--socket <absolute-path>] --json
astack herdr ensure --project <id> --json
astack herdr inspect --project <id> --json
astack herdr worker prepare --attempt <saved-attempt-id> --json
astack herdr worker inspect --attempt <saved-attempt-id> --json
astack herdr worker bind-agent --attempt <saved-attempt-id> --kind codex --json
astack herdr reconcile <space-id> --operation <operation-id> --writer-stopped --json
```

Global `--state-directory`, `--git-executable`, and `--herdr-executable` select trusted host resources. Without an explicit executable, the CLI searches only absolute host PATH entries. Herdr configuration is optional per registered project: absence returns `herdr_not_configured`. Nothing silently switches to an invisible/local agent execution path.

`configure` saves the explicit target and canonical registered main checkout in private SQLite state. It does not contact Herdr, start a session/server, create a space, install an integration, or grant agent execution permission. Repeating identical settings is safe. Changing an existing target, label or primary assignment returns a conflict; automatic retargeting/migration is deliberately not implemented.

The shared session defaults to the literal name `default`. A named session is an explicit isolation choice. Default socket paths are the standard host config-directory paths for the selected session; a custom installation must supply `--socket`. No `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, service cwd, focused pane or collection directory is used to infer a target. Paths supplied at the CLI boundary are made absolute. The provider requires the selected socket path to be canonical.

The initial grouping contract requires the registered **main** checkout as the project primary. A project initially registered from a linked checkout receives `herdr_unsupported` rather than silently choosing a different checkout. Configure an appropriate main-checkout registry identity before enabling this integration; registration relocation/reassignment remains separate work.

## Primary project spaces

Initialization ensures one primary project workspace by default. It uses saved Herdr target settings, or the standard default session and socket for a newly configured project. `--herdr-session` with `--herdr-socket` selects a different target. The default workspace name is the repository directory name; `--herdr-label` supplies a different name.

Astack reuses a workspace with the same name, regardless of its cwd, contents or repository association. If there are several matches, a matching saved workspace is preferred; otherwise the first match is reused. Users are responsible for choosing distinct names where they want separate workspaces. If no name matches, Astack records creation intent and asks Herdr to create a workspace at the project root without changing focus. The result reports the name, workspace handle and whether it was created or reused. A ready primary space is retained when workers finish. Pending creation remains inspectable and is not automatically replayed.

The saved target and workspace handle keep later operations directed at the selected space. Primary selection by name does not claim ownership of existing panes or agents. Worker checkouts and agent controls retain their separate attribution and ownership contracts. See [ADR 0028](adr/0028-project-workspaces-by-name.md).

## Grouped owned workers

Task submission persists an owned worktree intent, then asks Herdr to create the Git worktree and grouped child workspace together with an explicit path, branch and base commit. Astack verifies the checkout, workspace, parent and server, and stores the workspace receipt with the owned worktree. Runtime startup binds to this exact saved workspace; it does not reopen an existing checkout.

Project agents can set `workspacePrefix` to identify their child spaces. Implementation and review use `IMPL` and `CR` when no prefix is configured; a unique suffix distinguishes workers.

Configured ports are added to a new tab in the same child workspace before the agent starts. Before/after hooks run in the worker checkout. If creation is interrupted, the saved worktree intent prevents a duplicate create. After the original writer has stopped, `astack worktree reconcile <id> --operation <operation-id> --writer-stopped` asks the running service to inspect the matching Herdr workspace and settle the intent.

## Agent attribution

Preparation saves a bounded expected agent name derived from project/attempt identity. It creates no agent. Runtime launch must use the recorded pane and expected name and independently satisfy its execution policy.

`bindHerdrAgent({ schemaVersion: 1, attemptId, kind }, dependencies, signal?)` records an **already detected** agent only after fresh evidence agrees on expected name, kind, workspace, tab, pane, terminal, launch cwd and actual foreground cwd. Available native session IDs are retained; native session file paths are excluded. Binding and a retained `herdr-agent` resource are committed together. Repeated equivalent bindings are safe; a different occupant/session is not silently accepted.

Snapshot observations expose the agent's current `idle`, `working`, `blocked`, `done` or `unknown` status. These are provider observations, not accepted implementation/review results or proof that all writers stopped. In particular, Herdr's idle/done states do not release capacity, authorize a new writer, or complete an Astack attempt.

The namespace/terminal/name/cwd evidence establishes current attribution, not authentication against a hostile same-user operator. If no native session ID is available, the binding explicitly records null; it cannot prove continuity of two indistinguishable same-name/same-kind occupants in the same terminal. The runtime preserves its own launch intent and requires nonempty native-session evidence before control. This UI attribution alone is not a worker authorization token or proof of quiescence.

## Server and layout identity

Every record stores session, socket path, socket device/inode/change timestamp, supported protocol, and layout handles. The filesystem reader requires an owned private Unix socket in a canonical directory that is not writable by other users. Snapshot and write calls check endpoint identity before and after the CLI request, and writes also require the expected saved endpoint.

Protocol 22 provides no server-instance UUID. The saved tuple is therefore **transport identity evidence**, not an invented Herdr-issued nonce. A stable endpoint/live handoff may preserve this tuple. Astack revalidates worker topology, checkout provenance, terminal identity and recorded agent/native-session evidence; primary workspace selection uses its name; it does not establish historical continuity from an ID alone. A future Herdr server nonce would improve this boundary.

A ready primary can be rediscovered after restart by its saved workspace name and handle. Changed worker transport identity, moved panes, replacement terminals, wrong cwd, missing layout or changed native agent identity are reported as blockers. No old worker ID is silently redirected and no replacement agent starts. Manual layout migration and worker restart authorization remain separate work.

Snapshots are observations, not atomic snapshots across Git, filesystem, shell and Herdr activity. Supported adapters must return complete coherent snapshots. Hosts/layout writers must coordinate and recheck immediately before execution or future cleanup.

## Persistence, failures and recovery

Migration 5 adds `herdr_projects` and `herdr_spaces`; prior migrations remain unchanged. The store preserves immutable project/target/checkout assignment and uses compare-and-set revisions/operation IDs for pending layout writes. Worker reservations recheck persisted job/attempt and managed worktree assignment inside the transaction. No provider calls run in a transaction.

Only the caller that created or advanced the pending reservation can invoke a layout effect. Repeated prepare/ensure while pending returns `pending_writer`, even if a CLI timeout, client disconnect or expired process made the original result unclear. Post-effect inspection failures return pending evidence rather than claiming that no effect happened. Unknown, duplicate or contradictory layouts are preserved.

`reconcileHerdrSpace` performs reads and guarded persistence only. It requires exact saved space and operation IDs plus `writerStopped: true`, a trusted host attestation that the original layout writer and children stopped and cannot submit a late write. It is not a process/PID check and must not be supplied merely because a CLI timed out or an agent became idle. It never repeats creation/opening. Pending worker recovery also requires its operation label and fresh owned checkout/group evidence. A changed endpoint or missing/ambiguous layout stays blocked; no automatic reset, adoption or retry is available. An interrupted creation before any layout exists can consequently require later explicit host recovery tooling.

Results distinguish `prepared`, `reused`, `inspected`, `reconciled`, `blocked`, `pending`, rejected, and uncertain state writes. Results include saved records and bounded normalized observations where available. An inspected pending intent is still pending, not ready ownership. Effectful CLI exits with 1 for pending/blocked/rejected/uncertain; inspection with a missing-layout reason also exits 1. A completed observation never accepts a task result.

Stable provider errors are `herdr_unavailable`, `herdr_unsupported`, `herdr_invalid_output`, `herdr_not_configured`, and `herdr_conflict`, plus existing request/context/config/state errors. Raw stdout/stderr, tokens, titles, environment dumps and command arguments are not persisted as diagnostics. Provider reads retain only contract fields; API authors must keep secrets out of labels and opaque identifiers as well.

A missing binary/server, unsafe endpoint, unsupported protocol, truncated/lossy output or malformed snapshot blocks. Astack does not start/update/stop Herdr, switch sessions, install integrations or fall back to another worker runtime to fix it. The CLI supplies explicit controlled environment and argument arrays, with bounded capture/timeouts and no process artifacts.

## Cancellation and verification

Invalid/versioned requests and pre-cancelled operations cause no provider effect. Cancellation before persistence rejects. Cancellation after reservation can leave a pending intent; cancellation or failure after invocation never permits an automatic retry. Verified publication is persisted after fresh evidence even if cancellation arrives late. State uncertainty follows the normal reopen/inspect contract.

Default tests use injected provider layouts/process runners, disposable Git repositories, real owned worktrees and temporary SQLite state. They cover same-label projects, explicit sessions, ambiguity, competing writers, lost acknowledgements, server/layout changes, unowned layouts, provider blockers and verified/mismatched agent attribution. They neither mutate the user's live Herdr layout nor start real coding agents. Any live-provider check is a separate explicit opt-in.

## Runtime consumer

The separate [interactive Codex runtime](runtime.md) now consumes ready worker layouts. Herdr owns process execution; Astack reserves launch/action intent and verifies native session attribution. Layout operations themselves still launch no agents and close no resources.
