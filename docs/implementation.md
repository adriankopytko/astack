# Explicit implementation delegation

## Implemented scope

An orchestrator selects a task, project, ready owned checkout, branch and initial full SHA. `implement submit` accepts a durable implementation job through the local service. The coordinator launches the configured worker and hands it a deterministic initial prompt through the runtime's durable input primitive. `implement inspect` reads saved delivery and blocker evidence, including after the service stops.

This workflow does not select issues, create a checkout implicitly, provision project environments, publish changes, open PRs, trigger review automatically, automatically ingest reports or clean up workers. Worktree preparation is an explicit existing primitive. Successful task completion requires the separate explicit run report acceptance operation; UI idle/done and terminal-input acknowledgement are insufficient.

## CLI sequence

Prepare an owned checkout and approve the selected project's host configuration and Herdr target using the existing commands. `worktree prepare` returns the allocated registered checkout ID. Start the service with the explicit runtime opt-in, then submit from any directory:

```sh
astack service run --codex-herdr --codex-executable /trusted/bin/codex

astack implement submit \
  --project project-a --checkout allocated-checkout \
  --key selected-task-42 --branch task-42 --commit <full-initial-sha> \
  --task 'Implement the selected behavior.' \
  --criterion 'Preserve the existing public interface.' --json

astack implement inspect <job-id> --json
```

Use global `--state-directory` and `--herdr-executable` to select explicit host resources. The submit command requires a live service; it does not launch an alternate worker when that service is unavailable. Inspection opens existing state read-only and contacts no providers. Unknown commands fail before acceptance.

`--criterion` is repeatable. `--instruction <relative-Markdown-path>` is repeatable and replaces the default instruction path list (`AGENTS.md`, `AGENTS.override.md`). Include the defaults yourself when adding other instruction references. Missing files are explicitly recorded as absent. An empty instruction list is available to library callers; the prompt still requires applicable repository/native instructions. Directory-specific instructions must be read as the worker enters those directories. There is no recursive repository discovery, automatic tracker lookup, or implicit target from ambient cwd/focus.

The role is fixed to `implementer`, resolved under the current trusted host policy. The existing runtime currently blocks hooks, pinned skill delivery and explicit environment requirements that it cannot satisfy. Do not remove required configuration merely to make submission/launch succeed. The checkout must already be registered as a ready Astack-owned worktree in this project, with intact ownership/location, a clean Git status and exact initial branch/SHA. A primary or unowned checkout is refused. Preparation and task acceptance are separate operations, so an unused prepared checkout can remain after a rejected submission; nothing is automatically deleted.

## Durable acceptance and idempotency

`submitImplementation(request, dependencies, signal?)` accepts strict versioned input:

- `schemaVersion: 1`, explicit project/checkout, stable key, full branch ref and initial SHA;
- selected description, acceptance criteria and repository instruction paths;
- optional bounded configuration request overrides under host policy.

The job stores a versioned `implementation` task packet: normalized submission, owned worktree ID, canonical checkout path, instruction byte digests/absence and result contract version. The existing service transaction saves the task, role, project/repository/checkout, immutable approved configuration, attempt and pending launch effect atomically before agent launch. No new database migration is needed. Prompt text is reconstructed from that accepted packet and actual job/attempt IDs.

`ServiceStore.find` consumes the existing scoped idempotency index. Repeating the same normalized submission returns the original job and current saved state before inspecting changed worker files or re-resolving policy. This read grants no new effect or execution authority. Changed task, criteria, instruction paths, checkout, branch/SHA or overrides under that key conflict. Keys are scoped by local requester, project and implementation role; different projects can use the same key. Concurrent submissions ultimately serialize through the original acceptance transaction. A lost acknowledgement is handled by retrying the same submission/key, not by submitting a replacement.

`ImplementationSubmitResult` uses `persisted` with `created | existing`, `rejected`, or `uncertain`. Persisted acceptance is not verified worker start. Request validation and cancellation before acceptance start no worker. After acceptance, disconnect/abort cannot revoke durable intent; dispatch may continue independently. Inspect saved state after an uncertain acknowledgement.

## Context and prompt primitives

`ImplementationContextReader` reads only selected relative Markdown paths under the canonical assigned checkout. The filesystem adapter rejects traversal, symlink parents/leaves, hard-linked or nonregular files, invalid UTF-8, changed read evidence and files over 64 KiB. Reads are bounded and never execute instructions. It returns path/digest references, not repository file contents; those contents are not copied into job records or prompts. Default reads do not traverse other projects or host instruction directories.

A read-only workflow preflight checks context before capacity claim/launch. Before first input, the workflow refreshes the saved assignment, worktree ownership/location, branch/initial SHA, clean status, accepted policy and instruction references. Changed files/ownership/configuration block delivery. Initial instruction fingerprints are no longer frozen once delivery is acknowledged: the worker may legitimately edit repository files during its task. These are observations, not an atomic filesystem/provider snapshot; provider input must independently verify its own live target, and hosts must coordinate other writers.

The deterministic prompt contains:

1. Job/attempt/project/repository/checkout IDs, canonical cwd, branch and base SHA.
2. Initial instruction references and a requirement to read applicable repository and directory instructions.
3. The selected task and acceptance criteria as requester-provided data.
4. Bounded execution/handoff guidance and the versioned proposed result format.

Repository/task text never grants host permissions. The workflow requests implementation without publication, PR creation, merging, automatic review, new workers or host-configuration changes. These are workflow instructions, not a security boundary around a malicious native agent; the runtime's explicit host/server trust and native permission configuration still apply.

Descriptions are limited to 6000 UTF-8 bytes, criteria to 16 entries of 512 bytes, instruction paths to eight, and the normalized request to 9000 bytes. The runtime prompt must fit its 16 KiB lossless input contract. If unusually long identities/paths exceed that prompt bound, delivery reports `prompt_unsupported` without sending bytes. Tasks, criteria, paths and worker summaries must contain no credentials. The selected task is persisted and visible in explicit JSON inspection; no arbitrary environment or terminal transcript is collected.

## Runtime composition and reconnect

`createImplementationRuntime({ runtime, dependencies, workerInput })` decorates a generic `ServiceWorkerRuntime`. It declares `workflows: ['implementation']` and preserves the underlying runtime ID/notifications. The dispatcher refuses unclaimed workflow jobs with `workflow_unavailable` when the selected runtime does not declare that workflow. Merely configuring an executable is insufficient. A failed read-only workflow preflight records `workflow_blocked` before capacity claim or launch; an operator can fix prerequisites and explicitly wake the service.

The built-in Codex/Herdr composition installs this decorator. `createCodexImplementationInput` bridges the generic workflow input port to `inputRuntime` and its saved action receipts. Other coding agent integrations can implement the same workflow port without adopting Codex/Herdr internals. Generic service jobs still start a session without a workflow task prompt.

The input key is fixed and versioned: `implementation:initial:v1`, scoped to the saved attempt. Prompt bytes and their digest are deterministic. `ImplementationWorkerInput` must provide durable, bound, idempotent submission: reserve the key/digest before provider writes, expose persisted pending/acknowledged receipts and never replay pending writes. A provider without this guarantee must not implement the port. The workflow reads receipts before attempting initial input:

| Evidence                                                     | Behavior                                           |
| ------------------------------------------------------------ | -------------------------------------------------- |
| No receipt, verified running session, fresh accepted context | Submit initial input through the durable primitive |
| Matching acknowledged receipt                                | Observe progress without resending input           |
| Matching pending receipt or unavailable receipt evidence     | Retain uncertainty; do not repeat the write        |
| Different digest/kind under the reserved key                 | Block; preserve existing action                    |
| Approval/question UI                                         | Report `needs_decision`; send no input             |
| Busy/unavailable input surface                               | Preserve the session and report its blocker        |

Recovery `inspect` may perform the first accepted prompt submission when durable receipt absence is established and current preconditions permit it. It never restarts an already claimed launch or resends accepted/uncertain input. A crash after a durable input receipt but before saving coordinator observation is recovered by reading that receipt. A crash before input acceptance can continue the original authorized task. The service still owns capacity and uses no recurring GitHub/provider cron loop; startup, submission and explicit `service wake` drive passes.

Worker resources now retain immutable runtime/launch/space identity. Native session binding is separate evidence that may be learned after an uncertain launch. Existing compatible saved handles are preserved, so recovery does not rewrite resource identity merely because the agent binding became known.

## Status and proposed results

`inspectImplementation` returns the durable service job and an implementation progress view. It reads the last coordinator observation, not live agent state. Wake the service after meaningful external changes if fresh provider evidence is required. The saved view distinguishes:

| State             | Meaning                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `queued`          | Accepted, awaiting capacity/dispatch                                                           |
| `starting`        | Capacity claimed; launch/delivery observation not saved yet                                    |
| `started`         | The initial prompt has an acknowledged durable receipt and session evidence is available       |
| `needs_decision`  | A detected approval/question UI or input blocker needs deliberate operator attention           |
| `blocked`         | Configuration, ownership, context, workflow capability or input prerequisites prevent progress |
| `failed`          | The runtime proved its launch was refused/not started                                          |
| `unknown`         | Launch, input delivery, runtime identity or receipt evidence is uncertain                      |
| `awaiting_result` | A runtime with explicit quiescence evidence stopped; no result is accepted                     |

Delivery evidence is separate from progress. `acceptedOutcome` remains null until explicit run report acceptance (or local cancellation) establishes terminal control; worker liveness alone never establishes it. There is no `completed` implementation status inferred from provider liveness. The CLI exits 1 for rejected/uncertain, needs-decision, blocked, failed or unknown observations. A persisted receipt may already contain a blocker; that does not undo acceptance.

`implementationWorkerReportSchema` defines the worker's final JSON proposal: schema version, job/attempt/project/checkout, branch/base/current HEAD SHA, outcome (`completed | needs_decision | failed`), bounded summary and blockers. The prompt asks for a final response, not a file committed to the repository. The schema is a format contract only. Host report ingestion, assignment/freshness validation and accepted terminal outcomes are implemented through [run operations](runs.md). Explicit host publication consumes those outcomes through [validated handoff](handoff.md); remote worker authentication and cleanup authority remain separate. A worker's `completed` proposal, idle/done UI, Escape acknowledgement or successful prompt submission does not resolve its attempt or release capacity/resources.

## Verification

Disposable Git/state and controlled input/runtime fixtures exercise two-project isolation, policy/task/attempt persistence before effects, duplicate submission after worker edits/policy revocation, capacity queueing, exact assignment/instruction references and result contract, launch refusal versus uncertainty, worker approval blockers, missing workflow support, context drift, lost prompt acknowledgements, reconnect without replay, bounded instruction reads, neutral-cwd CLI/local transport, and actual Codex-adapter recovery using fake provider calls. Default checks start no real user agents, touch no live Herdr layout and make no GitHub changes.

Manual PR/SHA review is now a separate explicit workflow; see [review delegation](review.md). It does not reuse an implementation checkout or infer a PR from this task.

[Run operations](runs.md) now validate host-supplied report proposals and provide decisions, explicit continuation, cancellation and events. `acceptedOutcome` reflects accepted terminal control; a response or prompt receipt alone does not establish it.
