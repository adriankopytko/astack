---
name: astack-orchestrator
description: Delegate project work to configured Astack agents and inspect their handoffs when needed.
metadata:
  asset-version: '1.0.20'
---

# Delegate with Astack

Use this skill when handing project work to agents through Astack. Read `astack --skill` for the installed CLI contracts. Astack handles the queue, checkout, Herdr workspace, configured hooks, ports, and agent launch.

Run `astack agents list` in the project to see the configured agent names and descriptions. Choose the agent that fits the user's request. Use `--project <id>` when the current directory does not identify the registered project. Agent names are defined by the project; do not assume a fixed list.

Submit a handoff with `astack handoff submit --agent <name> --task '<task>'`. For GitHub context, add `--issue <number>` or `--pr <number>`; Astack infers the repository from origin, and `--repo <owner/repo>` overrides it. An issue or PR can be supplied without a separate task. `--base <full-sha>` selects the starting commit; use `--base pr-head` with a PR to start at its saved head without an extra lookup. Otherwise Astack uses the newest origin/main. A PR's saved context includes its head and comparison base.

Submission returns a handoff ID and does not mean the agent has started or finished. The service continues work independently: do not poll or wait for it by default. Use `astack run inspect <id>` when the user asks or the next action requires its result. If submission returns an uncertain error, inspect the reported handoff ID before submitting again.

An agent records its result with `astack run finish <id> --status completed|needs-input|failed --summary '<result>'`. A needs-input result identifies something requiring a decision. Do not treat terminal idleness as completion or infer that a finished run authorizes publication or cleanup.

Automatic follow-up between handoffs is not yet available. Submit a further handoff only when the user has requested that work and its inputs are available; do not monitor agents continuously.

The current Codex/Herdr runtime retains a worker's capacity claim after a result until shutdown is explicitly reconciled. If capacity fills, subsequent handoffs remain queued; do not assume an idle pane proves the worker stopped.
