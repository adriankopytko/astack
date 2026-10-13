# ADR 0001: Use SQLite through node:sqlite

Date: 2026-10-13

Status: Accepted

## Context

Astack needs durable local jobs, attempts, handoffs, results, resource ownership, and pending effects. Initial coordination is handled by one local service. A shared external database is unnecessary for that scope.

## Decision

Use SQLite through Node's built-in `node:sqlite` module, behind a small typed state adapter. This is the chosen persistence mechanism for the initial tooling, not a temporary requirement to migrate elsewhere.

Use versioned transactional migrations, prepared statements, explicit database settings, and short transactions. Do not run provider commands or await external effects inside transactions. Persist intent before effects and reconcile uncertain results. Store large logs/artifacts separately and reference them from state.

Runtime state lives outside source/worktree directories. An explicit state-directory override provides isolated development and verification. Include migration assets in the compiled package deliberately.

## Consequences

The [Node 24.20.0 API](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html) is marked release candidate, and `DatabaseSync` operations execute synchronously. Accept that API maturity for the initial project; keep storage details within the state adapter.

Keep operations and lock waits bounded so storage does not stall agent scheduling indefinitely. Reconsider execution placement or storage only when measured workloads or a changed coordination model require it. There is no current plan to add an ORM, external database, or replacement driver.
