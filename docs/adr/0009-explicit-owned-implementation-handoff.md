# ADR 0009: Explicit owned-checkout implementation handoff

- Status: accepted
- Date: 2026-10-17

## Context

The queue, configuration, owned worktree and interactive runtime primitives need a concrete implementation consumer. Starting a session alone does not deliver an implementation task. Crashes around prompt input can duplicate work unless delivery shares the runtime's durable input semantics.

## Decision

Accept explicit implementation submissions for an already prepared owned checkout. Keep worktree preparation a separate operation. Persist a versioned task packet, repository instruction references, approved configuration, attempt and launch effect through the existing service transaction before launch. Repeated submissions return the original identity; changed normalized intent under the same key conflicts.

Decorate a declared workflow-capable runtime with initial prompt delivery through a generic durable input port. Use a deterministic prompt and a fixed versioned input key scoped to the saved attempt. Reconnect may submit the first prompt only when receipt absence and fresh context are established; acknowledged or uncertain input is never replayed. Reuse existing runtime receipts rather than adding a competing delivery journal.

Pass assignment, requester context, instruction path/digest references and a versioned final JSON proposal contract. Read repository Markdown without executing or copying its contents into persisted prompts. Keep liveness, delivery acknowledgement, blockers and accepted domain results separate. Worker proposals never authorize cleanup or successful completion.

## Consequences

One orchestrator can now submit and inspect a selected implementation task using the existing primitives. The workflow can support other agents through explicit runtime/input ports. Local service transport remains the same host authority boundary, and missing workflow capability blocks before launch.

Preparation/provisioning are explicit prerequisites. Report ingestion/authentication/validation, accepted completion, review, publication and cleanup remain subsequent work. Unknown delivery and unproven shutdown continue to retain capacity. See [implementation delegation](../implementation.md) for request/result, concurrency, cancellation and recovery contracts.
