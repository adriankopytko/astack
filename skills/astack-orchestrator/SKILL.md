---
name: astack-orchestrator
description: Delegate implementation and code review through Astack, inspect accepted results, and choose explicit follow-up or recovery actions across registered projects.
metadata:
  asset-version: '1.0.1'
---

# Orchestrate with Astack

Use this skill for the orchestrator controlling an Astack workflow. An assigned implementation or review worker follows its own assignment and scoped worker skill instead. This guide supplies workflow knowledge; user authorization and private host policy determine which actions are allowed.

## Select the project and assignment

Read `astack --skill` for the installed command contracts when you need details; use command-specific help for arguments. Keep stable request keys and full commit SHAs in your handoff notes. A request returning a saved job is acceptance, not proof that an agent started or finished.

- `astack project list --json` finds registered identities. `astack context --project <project-id> --json` observes the selected checkout; explicit checkout/path/attempt selectors must agree. Invoking Astack from a directory containing several projects does not scan or choose one.
- `astack project register <path> --json` deliberately registers an unregistered canonical checkout. Registration does not install files, approve configuration or authorize workers.
- `astack config inspect --project <project-id> --role implementer --json` checks trusted host policy and prerequisites. Repository settings are proposals. Keep secrets out of descriptions, overrides, reports and logs.
- Prepare a dedicated owned checkout with `astack worktree prepare --project <project-id> --key <checkout-key> --branch <branch> --base <full-sha> --json`. Select its returned checkout ID explicitly. Preparing a worktree does not start a worker or provision services.

## Delegate and inspect

Start the local service only with the required host opt-ins. `astack service run --codex-herdr` enables the supported native runtime; `astack service run` alone has no worker adapters. The project's saved Herdr primary space is used rather than the calling pane. Preserve user focus and unrelated workspaces.

- `astack implement submit --project <project-id> --checkout <checkout-id> --key <task-key> --branch <branch> --commit <full-sha> --task <task-description> --json` delegates implementation with explicit acceptance criteria and instruction paths when needed. Use a fresh key for a genuinely different task, never to bypass an uncertain send.
- `astack run inspect <job-id> --json` reads accepted outcome, worker observation and retained resources separately. A worker's done/idle UI and a proposed JSON result are not accepted completion.
- `astack run events --job <job-id> --after <cursor> --wait 20000 --json` waits on local durable events. Save/acknowledge a consumer cursor only after processing its events. This does not poll GitHub or automatically collect worker output.
- `astack run collect-report <job-id> --key <report-key> --session-file <explicit-session-file> --json` collects a structured proposal from one host-selected matching session and submits it for ordinary validation. Never search unrelated transcripts or fabricate a completed report from the terminal badge.

When a report needs a decision, inspect the request. Record the chosen answer with `astack run respond <job-id> --key <answer-key> --decision <report-id> --text <answer> --json`, then explicitly authorize `astack run resume <job-id> --key <resume-key> --response <response-id> --json`. Continuation uses the same worker and durable input key. Pending/unknown delivery must be inspected and reconciled under its contract; never resend with a fresh key because the worker looks idle. Native approval/trust dialogs need an authorized host decision.

## Publish and review deliberately

An accepted implementation does not push or request a reviewer automatically. Before publication, verify the exact completed clean commit and required checks. With coordinator/original writers excluded, `astack handoff finish --file <request.json> --writers-stopped --json` accepts the explicit host verification/publication request. Its optional review request is not reviewer dispatch. Astack currently accepts host verification attestations; it does not execute project verification hooks for you.

For manual review, prepare a separate owned checkout at the exact PR head and use `astack review submit --project <project-id> --checkout <review-checkout-id> --key <review-key> --branch <branch> --commit <head-sha> --host <host> --repo <owner/repo> --pr <number> --json`. Use help for gate/check options and explicit no-CI/override policy; missing or skipped checks do not mean passing. The reviewer is read-only and must not start integration services.

For CI-triggered follow-up, explicitly enable project review automation and attach a dedicated checkout using `astack review automation enable --project <project-id> --revision <settings-revision> --json` and `astack review follow-up enqueue --handoff <source-job-id> --checkout <review-checkout-id> --branch <branch> --commit <head-sha> --json`. The service also needs `--observe-ci --after-handoff-review`. A disabled plan stays suspended until explicit resume; restoring flags does not silently resume backlog. Let the bounded CI observer and local events handle waiting.

Inspect accepted findings with `astack review result inspect <review-job-id> --report-key <report-key> --json`. Publication is a separate authorized host action. For fixes, select finding indexes in the returned immutable fix reference, prepare a fresh implementation checkout at the reviewed SHA, and use `astack implement submit` with its `--fix-of` file. Keep historical findings attached to their original SHA. There is no automatic fix loop, merge or approval operation.

## Recover and retain

- A disconnected client, timeout, expired claim or absent-looking worker does not authorize a replacement. Inspect saved launch/input/publication intents and exact provider evidence. Follow the installed recovery contract; preserve uncertain effects.
- `astack run cancel <job-id> --key <cancel-key> --json` blocks new work. An optional keyed interrupt is a request, not proof of shutdown. Repeating the original cancellation can settle an eligible never-launched legacy attempt without releasing resources.
- Accepted outcome, verified shutdown and checkout cleanup are separate. After independent host shutdown evidence, use the exact run reconciliation request. Do not manufacture stopped flags from age, PIDs, Escape or UI status.
- `astack cleanup request <job-id> --key <cleanup-key> --not-before <unix-ms> --json` saves retention policy. Only explicitly automatic requests plus `service run --cleanup` can execute automatically, and they still need established shutdown evidence. Preserve dirty/untracked/ignored files and unknown service holds. A started uncertain cleanup requires writer-excluded reconciliation, not retry by a new key.

Report concrete job/attempt/checkout/commit identities, accepted outcomes, blockers and next authorized action. Keep worker shutdown, service/resource stop, publication and cleanup evidence distinct. Preserve task branches and primary project spaces.

## Bootstrap a project deliberately

For a new project, inspect `astack init <path> --preview --json`. Apply with `astack init <path> --non-interactive --json` only within authorized setup scope. Optional repeated `--role implementer --role reviewer` installs project-local guides; user-level orchestrator availability is read-only and never installed implicitly. Initialization preserves authored setup and creates disabled host policy; it is separate from execution approval and delegation readiness. Herdr setup needs explicit session/socket or saved target. No detected scripts, dependencies or agents run. Preserve partial registration and pending writer intents; inspect their component recovery contracts before retrying. See `astack init --help` and the canonical `astack --skill` guide.
