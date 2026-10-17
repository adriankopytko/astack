# ADR 0010: Explicit manual review and SHA-bound gates

- Status: accepted
- Date: 2026-10-17

## Decision

Review is a manually requested workflow for a selected project, base GitHub repository/PR and full head SHA. It does not depend on an implementation claim or automatic scanner. Require an explicit existing owned reviewer checkout and approved reviewer role. A checkout is dedicated to one review attempt for its lifetime.

Share the initial-input delivery mechanism with implementation handoff. Preserve separate task contracts, prompts, input keys and policy. Recheck target and gates before dispatch and first input. Never replace the saved SHA after a head change. Record acceptance evidence and later observations separately; neither is an atomic provider snapshot.

Persist same-target duplicate selection and request aliases in the same SQLite transaction as acceptance. Deliberate repeats require a new key and fresh checkout and create a distinct job/attempt. Until report acceptance exists, saved reviews remain unresolved. Policy changes conflict; duplicates cannot amend a prior assignment.

Default dispatch requires an open non-draft PR with passing explicitly selected checks, or all observed checks if none are selected. Require at least one observed check under the default policy. A CI override needs a recorded request reason and trusted host permission; it grants no additional execution, target or resource authority. Static review requires no services; integration resource requests persist as blockers until provisioning exists.

## Consequences

The orchestrator can delegate external PR review without a background process scanning repositories. Reconnect retains the exact attempt and keyed prompt receipt. A reviewer cannot accidentally work inside the implementer's checkout. Target changes and CI blockers remain visible.

GitHub checks use bounded targeted CLI reads bracketed by matching PR observations. Duplicate check names, incomplete evidence and unsupported sizes block; branch protection evaluation and event-driven targeted waiting remain later work. No new persistence service is needed beyond node:sqlite. Report validation, cancellation, publication, fixes, automatic initiation and service provisioning remain outside this change.

See [the review operation contract](../review.md) for concrete inputs, effects, evidence, failure, retry and cancellation semantics.
