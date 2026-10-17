# Herdr project spaces and worker layouts

## Implemented scope

Issue #16 adds project-bound Herdr settings, persistent primary project spaces, grouped workspaces for Astack-owned worker checkouts, and verified attribution of already detected agents. It does **not** launch Codex, send prompts, execute project hooks, close workspaces, or register a service worker runtime. Those are separate operations. The installed service still has no real agent runtime adapters.

The integration was implemented against the installed Herdr 0.9.0 bundled protocol 22 schema (`herdr api schema --json`). The adapter explicitly supports protocol 22 and rejects incompatible snapshots. No live user layouts or agents are needed for default verification.

Herdr documents existing-checkout opening and grouping in its [CLI reference](https://herdr.dev/docs/cli-reference/#worktrees). Its [socket API](https://herdr.dev/docs/socket-api/) describes snapshot fields and scoped runtime identities. The installed schema is the authority for this adapter's supported wire shape; raw diagnostics and unrelated metadata do not become Astack results.

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

`configureHerdrProject` and `ensureHerdrProject` receive explicit versioned requests and injected dependencies. They recheck registry/Git/filesystem identity. One primary association is saved per enabled project, scoped to its explicit target.

An existing workspace is eligible only when its checkout provenance exactly matches the canonical main checkout and non-linked repository root. For an ordinary workspace without attached worktree provenance, all its panes must report that exact root cwd. Labels, tab order and focus do not establish identity. A single eligible workspace can be associated; multiple matches block as ambiguous. Reuse does not claim its panes/agents for cleanup or job execution.

When none exists, Astack persists pending creation intent before `workspace create --cwd <canonical-root> --label <label> --no-focus`. A fresh snapshot and fresh registered-project observation establish the resulting association. The saved handle contains workspace, tab, pane and terminal IDs. A primary pane is an explicit handle selected from that workspace, not an ambient focused pane.

A primary is persistent project visibility infrastructure. No worker finish, inspection, binding or reconciliation closes it. This issue supplies no group-close or generic close command. If a ready primary layout disappears, an explicit ensure can associate an unambiguous matching restored workspace or create a new primary without focus changes. Old worker records retain their original handles and are checked separately; restoring a primary never authorizes replacing a worker.

## Grouped owned workers

`prepareHerdrWorker({ schemaVersion: 1, attemptId }, dependencies, signal?)` resolves the persisted attempt and job. The project, repository, checkout, branch, commit and accepted policy come from those records. The target checkout must already be an Astack-managed ready worktree with matching registered filesystem identities and an intact ownership marker. Initial preparation requires the exact saved branch and full commit. It does not create a Git checkout, adopt an arbitrary linked worktree, or infer a parent from the calling orchestrator.

The saved job configuration is rechecked before opening a worker layout. The operation ensures the registered project's primary, reserves one durable worker intent for the attempt/checkout, and invokes:

```sh
herdr worktree open --workspace <saved-primary-workspace-id> --path <owned-checkout> --label <operation-label> --no-focus
```

No `worktree create`, `worktree remove`, `--force`, `--trust-repository`, pane input or agent-start command is used. Git worktree ownership remains with Astack's worktree operations. Opening an existing checkout can start a Herdr shell and trigger the server's own configured plugin behavior; Herdr's shell/plugin configuration is trusted host behavior, not a portable PR permission source. Astack does not install or alter it.

A fresh snapshot verifies the linked checkout, parent workspace, shared repository key/root, exact pane cwd and workspace/tab/pane/terminal relationships. An already-open unowned worker workspace is preserved and blocked. A race yielding `already_open` leaves pending evidence rather than adopting another creator's layout.

Ready worker handles and attempt-bound retained `herdr-space` resources are committed together. One worker association per attempt and checkout prevents another writer from adopting the same prepared layout. This slice does not release worker resources, recycle them for another attempt, or close their checkout/workspace. Review workflows can prepare a separate owned checkout; cleanup/handoff policy comes later.

Subsequent inspection permits commits made on the assigned branch while preserving the original base commit as assignment evidence. A changed branch, edited marker or replaced checkout blocks. Inspection does not claim that current HEAD still equals the starting commit or that new commits satisfy the task.

## Agent attribution

Preparation saves a bounded expected agent name derived from project/attempt identity. It creates no agent. A later runtime launch must use the recorded pane and expected name and independently satisfy its execution policy.

`bindHerdrAgent({ schemaVersion: 1, attemptId, kind }, dependencies, signal?)` records an **already detected** agent only after fresh evidence agrees on expected name, kind, workspace, tab, pane, terminal, launch cwd and actual foreground cwd. Available native session IDs are retained; native session file paths are excluded. Binding and a retained `herdr-agent` resource are committed together. Repeated equivalent bindings are safe; a different occupant/session is not silently accepted.

Snapshot observations expose the agent's current `idle`, `working`, `blocked`, `done` or `unknown` status. These are provider observations, not accepted implementation/review results or proof that all writers stopped. In particular, Herdr's idle/done states do not release capacity, authorize a new writer, or complete an Astack attempt.

The namespace/terminal/name/cwd evidence establishes current attribution, not authentication against a hostile same-user operator. If no native session ID is available, the binding explicitly records null; it cannot prove continuity of two indistinguishable same-name/same-kind occupants in the same terminal. The upcoming launch adapter must preserve its own launch receipt and strengthen native-session evidence when available. This UI attribution alone is not a worker authorization token or proof of quiescence.

## Server and layout identity

Every record stores session, socket path, socket device/inode/change timestamp, supported protocol, and layout handles. The filesystem reader requires an owned private Unix socket in a canonical directory that is not writable by other users. Snapshot and write calls check endpoint identity before and after the CLI request, and writes also require the expected saved endpoint.

Protocol 22 provides no server-instance UUID. The saved tuple is therefore **transport identity evidence**, not an invented Herdr-issued nonce. A stable endpoint/live handoff may preserve this tuple. Astack always revalidates topology, checkout provenance, terminal identity and recorded agent/native-session evidence; it does not establish historical continuity from an ID alone. A future Herdr server nonce would improve this boundary.

A ready primary can be rediscovered after restart through its canonical project checkout. Changed worker transport identity, moved panes, replacement terminals, wrong cwd, missing layout or changed native agent identity are reported as blockers. No old worker ID is silently redirected and no replacement agent starts. Manual layout migration and worker restart authorization remain separate work.

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
