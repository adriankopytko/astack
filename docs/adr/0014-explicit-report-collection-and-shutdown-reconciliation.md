# ADR 0014: Explicit report collection and shutdown reconciliation

- Status: accepted
- Date: 2026-10-19

## Context

A supervised review completed, but collecting its final JSON required a manual host step. The review prompt's snapshot placeholder also encouraged a string where the report schema requires an object. Separately, verified physical shutdown left historical resource holds and scheduler capacity retained. An idle pane or missing PID alone does not establish shutdown.

## Decision

Add a provider-neutral `RunReportReader` and `collectRunReport` operation. Collection constructs a strict report proposal envelope; the owning coordinator still performs normal report acceptance, including acknowledged input, current checkout and exact review target checks. It does not normalize malformed proposals or accept them on collection alone.

The first reader uses an explicitly selected local Codex JSONL session file. It verifies the bound ready launch/job/attempt/effect/checkout, session metadata cwd and creation time, captured native ID if present, and one exact saved assignment message. Only the latest typed assistant final response after that assignment and after the latest user message is eligible. Do not search global transcripts, scrape terminals, execute transcript contents or persist unrelated messages. Reject changed, linked, malformed, oversized, truncated or ambiguous input. This optional local provider adapter is not a generic persistence format or remote authentication mechanism; Codex log format changes may require adapter changes.

Persist review prompt version 2 on new tasks and embed the actual snapshot object in its result example. Missing prompt versions retain version 1 bytes, keys and hashes. Existing accepted task intent and input receipts are never rewritten to improve an example.

New review tasks now use prompt version 3, which retains the object snapshot and shows finding `line` as a JSON number with explicit positive-integer guidance. A supervised findings pilot showed workers copying the version 2 string placeholder. Version 1/2 rendering remains byte-for-byte stable for saved tasks; schema validation still rejects string line numbers without coercion.

Add offline `run reconcile` under exclusive coordinator ownership. Require an exact job/attempt/launch/control revision and explicit host attestations that the worker and descendants, attempt services and original effect writers have stopped. Inspect the same saved Herdr server to confirm the owned worker workspace, terminal and agent are absent. This provider evidence supplements the attestation; it does not prove descendant/service shutdown. Other host controllers must remain excluded throughout verification and commit.

Atomically record the reconciliation, mark the service observation quiescent, release only the four exactly bound worker/runtime/layout/agent holds, advance the control revision and append an event. Unknown retained resource kinds, missing or changed bindings, pending runtime actions and unresolved continuations prevent the whole transaction. Keep worktree/branch removal separate. Preserve accepted completion/failure; verified cancellation resolves the attempt as cancelled without claiming task success. Identical reconciliation requests return their saved record without a fresh provider call; changed requests conflict. Restart skips the quiescent entry and makes its capacity available to queued jobs.

The journal contract stores provider-neutral worker handles and resource bindings; the Codex/Herdr verifier constructs its four allowed bindings. SQLite migration 10 stores the reconciliation journal. Its state decoder also preserves the first pilot representation without rewriting the historical host attestation. `cleanup.resourceCount` counts historical records; `retainedResourceCount` counts unreleased holds. `cleanup.state=reconciled` records lifecycle reconciliation, not physical checkout deletion.

The CLI composition exceptions are exact pairs: `cli/service.ts` → `host/local-service.ts` and `cli/runs.ts` → `host/reconcile-run.ts`. Other CLI-to-host edges remain forbidden and fixture checked.

## Consequences

One orchestrator can collect a selected final response without manually extracting JSON and reclaim verified stopped capacity without editing state. Neither operation runs continuously. Automatic return-channel discovery, authenticated worker inboxes, provider-certified descendant shutdown, orchestrator notifications and additional resource-specific cleanup remain later work. Routine tests use controlled logs, providers and disposable repositories; live inspection remains opt-in.
