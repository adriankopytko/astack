# ADR 0011: Durable run events and explicit controls

- Status: accepted
- Date: 2026-10-17

## Decision

Keep run outcomes/control state separate from worker observations and cleanup. Add transactionally appended monotonic local events, scope-specific compare-and-set consumer cursors, host-accepted versioned reports, decision responses, keyed continuation attempts and cancellation intent in node:sqlite.

The orchestrator supplies and explicitly accepts reports through the same-host service. Validate assignment, acknowledged prompt, exact checkout evidence, review scope and bounded artifact references. A parsed worker proposal alone is insufficient. Acceptance does not prove business correctness or worker shutdown and never cleans resources automatically.

Resume continues the same verified worker through a durable native input key. Pending/unknown inputs do not replay; an authorization persisted before any attempted effect may make its first delivery. Cancellation wins future claims transactionally, blocks new launch/input at host boundaries and optionally requests a verified keyed interrupt. Running effects may still finish across the non-atomic provider boundary. Preserve work, retained resources and uncertainty.

Event reads/waits operate on local state without an idle agent pane or prompt injection. Bounded waits and explicit cursor acknowledgement support disconnect/reconnect replay. Reading does not acknowledge processing; processing/delivery is not exactly once. Existing service jobs receive baseline events when migrating.

## Consequences

A new orchestrator can recover accepted results and blockers, resume deliberately and request cancellation from durable evidence. Native liveness, task outcome, CI observations and cleanup remain distinct. Report files/artifact references have strict bounds; artifacts are observed references, not an immutable archive. Same-host authority is not remote worker authentication. Automatic report harvesting, runtime wake-up, provider event subscriptions, dashboards, publication, automatic remedies and cleanup remain outside this decision.

See [run operations](../runs.md) for exact contracts, retries, cancellation boundaries and CLI behavior.
