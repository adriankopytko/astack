# ADR 0008: Herdr owns interactive Codex execution

- Status: accepted
- Date: 2026-10-17
- Worker identity requirement amended by [ADR 0012](0012-optional-native-worker-session-identity.md).

## Context

The durable dispatcher and project-bound Herdr spaces need a concrete coding agent runtime. Using both an Astack subprocess supervisor and Herdr agent control for the same session would give two components competing execution ownership. Provider calls can complete before their acknowledgement is saved, and UI completion indicators do not establish task outcomes.

## Decision

Use the generic service runtime port with a `codex-herdr` implementation. Herdr starts and hosts canonical interactive Codex; Astack persists and reconciles launch/action intent, verifies assignment and refreshes host policy before new controls. The runtime uses an explicit owned worktree/pane and native session identity. Codex runs with approved bounded interactive arguments and `--no-daemon`; no headless or app-server integration is introduced.

Persist a single stable launch identity and retained runtime resource before starting. Repeated start and restart recovery inspect existing intent, never replay an uncertain launch. Input/interrupt have keyed digest-only action history and a single pending writer. Missing acknowledgement preserves uncertainty and blocks later control. Neither age nor absence is replacement authority.

Make server trust an explicit host opt-in. Protocol 22 cannot select an absolute agent executable, isolate its inherited environment, atomically guard native identity on mutation, or attest process quiescence/turn delivery. Declare these missing capabilities. Unsupported configuration requirements block. Keep task result validation, workflow prompt construction, broader provisioning and cancellation/cleanup separate.

## Consequences

One execution component owns each interactive session, while generic scheduling stays independent of Codex/Herdr details. Reconnection can recover a matching native session without duplicate writers. CLI capabilities and fixed errors expose compatibility limits.

The host must attest server canonical executable resolution and ambient configuration. Snapshot/write races with another same-user controller are a documented precondition, not solved by stored handles. Lost action acknowledgements and absent pending launches need future explicit settlement tooling. Idle/done and Escape never release capacity or establish accepted completion. See [the runtime contract](../runtime.md) for current APIs, required host policy and recovery semantics.
