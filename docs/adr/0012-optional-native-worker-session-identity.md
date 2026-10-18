# ADR 0012: Native worker session IDs are supplementary evidence

- Status: accepted
- Date: 2026-10-18
- Amends: [ADR 0008](0008-herdr-owned-interactive-codex.md)

## Context

Herdr protocol 22 declares native agent session metadata optional. Read-only inspection of the installed server found it absent from live agent, pane and snapshot responses. The initial Codex/Herdr runtime and its controlled fixtures required a native ID before binding or controlling a worker, preventing otherwise matching workers from receiving their assignment.

The generic service runtime port already accepts provider-specific handles. It does not require Codex session IDs, and no new generic identity subsystem is needed.

## Decision

Bind the Codex/Herdr worker using its persisted launch/attempt, explicit server endpoint, unique attempt agent name, owned checkout, layout, terminal, agent kind and working directory. Native session IDs are optional supplementary evidence captured at binding. When captured, their disappearance or change blocks control. Metadata first appearing after a binding without an ID does not upgrade or rewrite that binding.

Recheck attribution immediately before input/interrupt and target the saved unique agent name rather than its pane. Herdr documents live names as unique and cleared when an occupant exits or is replaced. Require one trusted controller per worker and prohibit other host tools from reusing Astack-reserved names. Preserve uncertain launches/actions; missing evidence never authorizes a replacement, replay, resource release or cleanup.

## Consequences

Workers can receive assignments and reconnect without native session metadata. Existing bindings with IDs keep their stricter checks, and the existing nullable storage shape needs no migration. Controlled verification must cover absent/null metadata, captured ID loss/change, missing/replaced names, changed terminal attribution and uncertain writes.

Names and layout are local attribution under host coordination, not authenticated process-generation tokens. Another same-user controller could reclaim the same name in the same terminal/checkout; that replacement is not detectable from name/layout alone. Herdr still offers no atomic compare-and-mutate guard. Targeting by name narrows accidental pane-reuse exposure but does not eliminate all replacement races or prove process shutdown. A live pilot remains necessary; inspection of existing agents does not prove launch compatibility.
