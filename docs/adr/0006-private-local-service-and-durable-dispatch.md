# ADR 0006: Coordinate durable dispatch through a private local Unix socket

- Status: accepted
- Date: 2026-10-17

## Context

One orchestrator needs to hand off work and disconnect while accepted intent remains durable. Capacity and launch recovery must span projects, and two service processes must not start competing writers. Expired database claims or a dead coordinator do not prove an external worker never launched.

## Decision

Use a foreground local service with a private Unix-domain JSON socket on supported Linux/macOS hosts. Filesystem ownership/private modes provide minimal same-user caller authority. Do not introduce HTTP, TCP ports, Hono, remote hosting, daemon installers or multi-user authentication for this slice.

Hold a separate local SQLite exclusive lock for the complete coordinator lifetime. Ordinary queue/state transactions remain synchronous and short. Process exit releases coordinator ownership; launch claims remain durable and require provider evidence after restart. Never steal ownership based on a PID, timer or expired worker claim.

Persist configured job, initial attempt, pending launch effect and queue entry atomically. Claim global/per-role capacity and serialize checkout/repository-branch writers before external launch. Uncertain effects retain capacity. Runtime start/inspection is injected; the default CLI installs no real worker runtime. Configuration pointing to an executable does not install an adapter.

Reconcile prior effects before dispatching new work. Wake on startup, submission, adapter lifecycle notification or explicit request; do not poll GitHub/providers on a timer. Never replay an already claimed launch automatically. Keep verified worker quiescence separate from accepted domain reports and terminal task outcomes.

Bind the control endpoint to private ownership metadata and socket device/inode. Remove a stale endpoint only under coordinator ownership with matching evidence; preserve unmarked/edited endpoints. A publication crash window can require manual host inspection.

Use one narrow host composition root for library/CLI foreground consumers. Enforce the exact CLI-to-host entry exception with dependency-cruiser while preserving the prohibition on CLI/transport imports.

## Consequences

Accepted jobs survive client disconnection and service restart. Different roles and projects share durable capacity without requiring application ports. Local caller authority remains explicit but coarse: any process with access to the user's private control socket can submit/inspect allowed work. Restricted worker report credentials need a separate future surface.

The service foundation can be exercised with controlled fixture runtimes. Codex/Herdr adapters, workflow-specific handoffs, CI/report endpoints, cancellation and terminal result acceptance are separate issues. Until those adapters arrive, CLI submissions can persist and report blocked runtime availability without launching an agent.

Local filesystems must support SQLite locking and Unix sockets; socket paths have a portable length limit. Network/distributed state and hostile same-user races are unsupported. Runtime adapters must bound/cancel calls; ownership cannot be released while an earlier launch call can still write. A forced exit leaves uncertainty for inspection rather than guaranteeing worker shutdown or exactly-once execution.
