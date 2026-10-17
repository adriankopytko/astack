# ADR 0007: Bind Herdr project spaces and worker layouts explicitly

- Status: accepted
- Date: 2026-10-17

## Context

Projects should remain visible in a shared Herdr session while owned implementation/review workers have separate grouped checkouts. Labels and focused panes cannot identify a project, and process/CLI interruption can leave an uncertain creation result. Herdr runtime IDs belong to one server/transport namespace and can change with user layout edits or restart.

## Decision

Persist per-project Herdr settings outside portable project config, bound to registered main-checkout identity. Use a shared explicit `default` session unless the host deliberately selects a named session/socket. Never inherit the caller's pane, workspace, socket or focused project. Reuse only an unambiguous canonical primary match; otherwise reserve intent before creating without focus.

Keep Astack's owned Git worktree lifecycle. Use Herdr's existing-checkout opening surface to create grouped worker workspaces under the saved primary. Do not create/remove Git worktrees through Herdr or adopt an already-open unowned worker workspace. Persist workspace/tab/pane/terminal handles and independently verify current agent attribution before saving an agent binding.

Use strict normalized snapshots from an injected Herdr provider. The initial adapter uses a trusted absolute CLI with explicit socket/session environment and argv, against the installed Herdr 0.9.0 protocol 22 schema. Reject unsupported/incomplete output rather than guessing compatibility or switching execution paths. Keep native session IDs where available and discard unrelated metadata/paths.

Herdr exposes no server-instance UUID in this protocol. Save socket filesystem identity as transport evidence and always revalidate canonical checkout, group topology, terminal and occupant facts. Changed worker namespace/layout requires inspection rather than replacement. A ready primary may be rediscovered/restored without closing its workers.

Reserve durable creation/opening intent with compare-and-set revisions before provider writes. Pending retries never write again. Explicit reconciliation requires operation-bound host quiescence attestation and only inspects/persists evidence; it never replays an external effect.

## Consequences

One orchestrator can prepare project visibility from any directory while each project remains separate, even with identical labels. Primary spaces outlive jobs. Worker resources and agent bindings remain attempt-bound and retained for later cleanup policy.

This integration manages visibility/layout and verifies existing attribution; it does not launch agents, send prompts, accept reports, close resources, or install a service worker runtime. Codex execution and service wiring remain the next slice.

The first contract requires a registered main checkout, immutable target settings after configuration, and protocol 22. Unsupported layouts/providers and unresolved intents block with actionable diagnostics. A host may need explicit recovery tooling for missing layouts during an uncertain write. A future server-issued instance nonce and more precise layout migration APIs would improve recovery without weakening ownership checks.

The server's shell/plugin settings are trusted host behavior. Snapshot/endpoint observations are not an atomic cross-provider transaction, identity evidence is not authentication, and no exactly-once execution or worker quiescence is inferred from layout/agent status.
