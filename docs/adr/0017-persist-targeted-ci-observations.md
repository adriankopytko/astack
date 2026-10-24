# ADR 0017: Persist shared targeted CI observations

- Status: accepted
- Date: 2026-10-24

## Context

Accepted review work needs to wait for CI without starting an idle worker or repeatedly scanning a repository. Several projects or gates can depend on the same exact PR commit, while source cancellation, stale targets, provider limits and service restarts must preserve distinct outcomes.

## Decision

Migration 12 separates CI subscriptions from shared observations keyed by canonical host/repository/PR/full SHA and persists host-wide API-slot budgets. Enrollment consumes an existing manual review job or an accepted handoff's explicitly authorized follow-up. Bind project/primary-checkout identity, source/gate, policy digest and deadline; revalidate before provider reads and request settlement.

Expose library operations and `ci watch/inspect/list/suspend/resume/cancel/complete/wake`. Enable the service observer only through host opt-in. It schedules saved due targets with bounded passes, exponential backoff, positive jitter, deadlines, per-host budgets and rate-limit cooldowns. Claims capture request revisions and reserve a conservative maximum API cost before reading. The provider enforces that operation's API subprocess ceiling. Restart may replace only expired read claims; late tokens cannot settle newer observations. Write recovery rules remain unchanged.

Persist request decisions, shared evidence/schedule and run events transactionally. Explicit controls invalidate in-flight request revisions. Ready, blocked, suspended and terminal subscriptions stop reading; resumption is explicit and cannot retarget a source. Missing checks remain pending unless the saved gate requests no-CI behavior and private host policy permits it. Preserve older optional-field absence and prompt/configuration bytes.

Keep fresh review acceptance/dispatch/input/report gates independent of cached readiness. This operation neither creates review jobs nor launches workers; automatic follow-up dispatch remains a separate consumer. Use a primary registered checkout for API cwd so implementation cleanup does not invalidate CI context.

The local service takes coordinator ownership before writable database opening/migration, and drains CI reads before closing state or releasing ownership. Default startup does not enable observation.

## Consequences

One observation can serve different project gates without multiplying GitHub scans or holding a worker open. Conservative budget reservations may underuse available provider capacity. The budget counts API subprocess attempts and does not govern unrelated CLI/API traffic or establish exact GitHub point usage.

Readiness remains historical and remote checks can change immediately afterward. Auth/configuration/target blockers require explicit action; policy or context drift can require a new enrollment. A future automatic dispatcher must recheck exact target, current readiness, host automation policy, owned checkout and capacity. See [the operation contract](../ci.md) for bounds, cancellation, errors and verification status.
