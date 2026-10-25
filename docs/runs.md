# Durable runs, events and explicit controls

## Implemented scope

A run is the saved service job and execution attempt, its accepted reports, decision responses, continuation attempts, cancellation intents and resource evidence. `run inspect` works offline. `run events` reads or waits for durable local changes without querying GitHub, inspecting an idle pane or injecting a prompt. Report and decision mutations use the owning local service. Explicit shutdown reconciliation runs offline under coordinator ownership.

These operations consume implementation/review assignments. They do not discover tasks, ingest arbitrary terminal transcripts, authenticate remote worker submissions, automatically wake an orchestrator, create replacement workers, publish changes, or clean up work. The private Unix socket has same-host-user authority. `run report` is an explicit orchestrator/host acceptance operation for a supplied proposal, not a restricted worker-report endpoint.

## CLI

```sh
# Inspect saved assignment, task outcome, worker status and retained resources.
astack run inspect <job-id> --json

# Validate and accept a versioned worker JSON proposal selected by the orchestrator.
astack run report <job-id> --key report-1 --file ./worker-result.json --json

# Alternatively select the exact local Codex session file; collect and validate its final report.
astack run collect-report <job-id> --key report-1 \
  --session-file /absolute/path/to/rollout.jsonl --json

# After independently verifying shutdown and closing only the owned worker workspace,
# stop the coordinator, then reconcile its exact saved launch/revision.
astack run reconcile <job-id> --key shutdown-1 --attempt <attempt-id> \
  --launch <launch-id> --revision <control-revision> \
  --worker-stopped --services-stopped --writers-stopped --json

# A needs_decision report supplies its report ID as the decision identity.
astack run respond <job-id> --key answer-1 --decision <report-id> \
  --text 'Use the existing interface.' --json
astack run resume <job-id> --key continuation-1 --response <response-id> --json

# Cancellation is durable before any optional native interrupt.
astack run cancel <job-id> --key cancellation-1 --json
astack run cancel <job-id> --key interrupt-1 --interrupt --json

# Read without advancing the consumer, process the page, then acknowledge it.
astack run events --project project-a --consumer orchestrator --wait 20000 --json
astack run cursor ack orchestrator --project project-a \
  --expected <previous-offset> --after <page-nextCursor> --json
astack run cursor inspect orchestrator --project project-a --json
```

All commands honor global `--state-directory`; no target is inferred from an ambient pane. Inspection, cursor reads and event reads/waits open existing state read-only, without bootstrapping or migrating it. Report acceptance (including collected proposals), response, resume, cancellation and cursor acknowledgement require the local service. Reconciliation requires it stopped. No live runtime is needed to inspect/accept already delivered reports. Native input/interrupt requires the explicitly enabled approved runtime; its absence blocks controls.

`--file` accepts either the worker's original report object or `{ "proposal": <report>, "artifacts": [...] }`. CLI reads are bounded at 48,000 bytes and reject symbolic links, nonregular files and detected mutation. Requests/results use strict versioned schemas. Human output distinguishes run state, worker state and retained cleanup; JSON retains the complete evidence. Exit 1 can describe a saved blocked/unknown/failed/needs_decision run, not an absent request.

## Report validation and acceptance

`acceptRunReport` requires the original job/attempt/project/checkout, workflow report schema and acknowledged initial prompt with the expected key/digest. Fresh evidence must establish the owned worktree, canonical location, branch and full current SHA. Implementation base SHA must equal its saved assignment; reported head must equal observed HEAD. Completed implementation and static review require a clean checkout. Failed/needs_decision implementation reports can describe retained dirty work.

Review reports must reproduce the saved target, gate and acceptance snapshot. A targeted GitHub read rechecks the exact PR head and base SHA and records fresh CI evidence. Changed scope rejects current acceptance. Completing a review records that review work finished; it neither approves the PR nor declares CI, findings or merge readiness successful.

Artifact references are bounded relative paths, SHA-256 digests and byte sizes. At most eight files, four MiB each and sixteen MiB total, may be inspected. Reads reject traversal, `.git`, links, nonregular files, wrong digests/sizes and detected mutation, including leaf replacement. Only references are stored. These are observations of retained checkout files, not immutable artifact copies; revalidate bytes before later use. Report validation repeats checkout inspection before persistence. It cannot atomically lock Git/files/provider state against later changes; the host must coordinate writers. Accepted evidence remains historical if later work changes the checkout or PR.

Acceptance atomically stores the report, control revision, terminal result where applicable, and event. `needs_decision` opens a decision without resolving the execution attempt. `completed`/`reviewed` and `failed` create the existing state's terminal result and resolve the attempt. No resource is released from a report alone. A worker still observed running or unknown continues occupying capacity until trusted quiescence evidence exists.

This validates structure, assignment and observed evidence. It does not cryptographically authenticate report authorship, prove the business behavior or independently rerun claimed tests. The same-host orchestrator selects and accepts the proposal. Never accept arbitrary terminal text or treat a reported check as independently verified merely because its JSON parses.

Keys are scoped to job and operation. An identical report retry returns saved acceptance without inspecting a now-modified checkout or revoked policy. Different input under that key conflicts. A new report after terminal completion/cancellation is rejected. Concurrent cancellation or continuation changes the revision and prevents stale acceptance. An unresolved resume input blocks new report acceptance. Existing generic terminal state results also prevent dispatch, without fabricating a validated workflow report.

## Explicit structured report collection

`collectRunReport` consumes an injected `RunReportReader` and returns a strict `RunReportRequest`; it never accepts completion or releases resources. The CLI's `run collect-report` uses the optional Codex adapter and sends that proposal through normal coordinator acceptance. `run report --file` remains available for other providers and manual proposals.

Select one exact local Codex session JSONL file explicitly. No global session search or terminal capture occurs. The adapter checks the bound ready job/attempt/effect/checkout, exact session cwd, session start at/after job acceptance, native session ID if captured, and one user message containing the exact reconstructed assignment. It reads only typed `response_item` assistant messages with `phase=final_answer`; a later user message without a new final response, duplicate assignment, malformed JSON or invalid report shape rejects collection. A formatting correction can be requested explicitly from the same worker. There is no silent conversion of a string snapshot into an object.

Files are bounded at 16 MiB, JSONL records at one MiB and final proposals at 48,000 bytes. Reads reject symbolic/hard links, nonregular files, detected mutation, incomplete final lines and invalid UTF-8. Only the proposal reaches acceptance; unrelated log contents are neither printed nor stored. Use a host-trusted path and coordinate writers; this is same-user attribution, not cryptographic authorship. A provider log format change fails closed and may need an adapter update.

New review assignments persist prompt version 3, whose example embeds the actual `acceptanceSnapshot` object and a numeric finding `line`. The prompt explicitly requires the actual positive integer line number as a JSON number, not a quoted string. Saved version 2 tasks retain their original object snapshot and string placeholder; version 1 and tasks without a prompt version retain their original rendering. All saved prompt bytes and input digests remain stable across restart. Collection and acceptance always reconstruct the saved version; report validation does not coerce string line numbers.

## Decisions and continuation

`respondToRun` saves a bounded response to the currently accepted needs_decision report. It sends no input and grants no new execution policy. Duplicate keys preserve the original response; changed text conflicts. Responses are bound to the execution attempt and decision/report ID.

`resumeRun` records a distinct continuation identity, selected response, reserved native input key and authorization before effects. It reuses the existing claimed worker. It does not create a new execution attempt, checkout or agent. Configuration, ownership and review scope/gates must still permit continuation. Native input additionally rechecks the saved pane/terminal/cwd/native identity and permission policy through the existing runtime.

The continuation advances through authorized → pending → acknowledged/blocked/unknown. A compare-and-set transition permits only one sender. Resume keys/digests bind the exact saved response; pending/acknowledged input never resends. An acknowledged continuation permits a subsequent report; it is not proof the worker completed the task. A blocked request with proven receipt absence returns the run to needs_decision. Record another explicit response/continuation to change the decision; do not manufacture a replacement worker.

After a crash, an authorized continuation with no attempted input may make its first delivery. Pending/unknown continuation retries only reconcile the saved native receipt and never infer absence from UI state. A pending intent with no receipt remains unknown because the effect boundary was crossed. No lease expiry, age, idle pane or new key clears it. Native approval/question dialogs remain deliberate operator interactions; a decision response is not permission to answer those dialogs automatically.

## Cancellation and cleanup

`cancelRun` saves intent transactionally. Queue claims check that control inside the same immediate transaction; the coordinator skips halted jobs and rechecks immediately before start. The built-in runtime checks again before new launch/input reservation and immediately before provider writes. Cancelling during configuration/preflight prevents a later claim. New task input is blocked after cancellation or terminal acceptance. Explicit verified interrupts remain possible to stop a retained worker, including after accepted completion.

A never-claimed job or a worker already proved not started/quiescent becomes cancelled locally. A claimed/running/unknown worker remains cancel_requested. Optional `--interrupt` requests one keyed Escape through the existing runtime, with fresh ownership/native/policy checks. Wrong/missing bindings, approval UI, unavailable controls or uncertain input block it. Repeating the same cancellation key never sends another interrupt. A separate later key can explicitly request interrupt after an earlier intent-only cancellation.

Interrupt acknowledgement is not shutdown proof. A later verified quiescent/not_started observation settles cancel_requested to cancelled. A request arriving after a terminal report preserves the accepted outcome. Effects authorized immediately before cancellation can still finish: provider APIs have no atomic compare-and-write transaction with SQLite. Such writes stay bound to their original attempt and remain inspectable; they never authorize a replacement. There is no force-kill, branch deletion, worktree removal or automatic capacity release by age.

Cleanup remains `retained` until explicit lifecycle reconciliation. Inspection includes the historical `resourceCount`, current `retainedResourceCount`, at most 100 resource summaries, checkout ID and any reconciliation record. An empty summary alone never establishes safe deletion.

`run reconcile` is an offline trusted host operation: stop the coordinator and all original effect writers first, independently verify worker/descendant and service shutdown, and close only the attempt's owned worker workspace. The CLI acquires the coordinator lock before opening/migrating writable state. A running coordinator blocks the command. Supply the exact attempt, launch and control revision, a stable key and all three truthful attestations. The library's `reconcileRun` caller must provide equivalent exclusion.

Fresh inspection of the same saved Herdr server must show the owned workspace, terminal and named agent absent. This observation cannot prove descendant or service shutdown; the recorded source is explicitly `host-attestation`. Missing/changed provider identity, a live workspace/agent, pending runtime actions, unresolved continuations, missing resource bindings or unknown retained resources preserve every hold. Do not infer the attestations from age, idle/done, Escape, missing layout or one missing PID.

One transaction records evidence, releases only the exact bound worker, interactive-runtime, Herdr-space and Herdr-agent resources, advances revision, marks the service observation quiescent and emits `lifecycle_reconciled`. Accepted completion/failure is preserved. Verified cancellation records a cancelled result and resolves its attempt without claiming success. Identical requests are idempotent offline; different requests conflict. After restart the entry remains quiescent and the next queued job can use capacity. `cleanup.state=reconciled` means those lifecycle holds were settled; checkout removal is still the separate ownership/cleanliness-checked `worktree remove` operation. Task branches and unrelated resources are preserved.

## Events and consumer cursors

Migration 8 adds append-only events, control projections, reports, responses, continuations, cancellations and cursors. Queue acceptance/claim/block/observation and run mutations append events in the same SQLite transaction. Existing service entries receive baseline events during migration; migration does not replay provider effects or invent validated reports. Committed event IDs increase globally and are independent of wall-clock ordering.

`readRunEvents` accepts optional project/job scope, exclusive `after`, page size 1–100 and wait 0–20,000 ms. A page records a high watermark, reads only IDs through it and supplies `nextCursor`. A full page continues from its last event; a drained page advances to the scanned high watermark, including gaps belonging to other scopes. Events committed after that snapshot remain readable on the next page. Future/invalid offsets and conflicting targets reject rather than resetting.

Waiting uses short bounded local SQLite reads, not GitHub/provider polling. Host/CLI waiting uses a monotonic clock. It is independent of coding-agent panes and works with the service stopped if another authorized local writer is present. Timeout returns a page; abort/client disconnect/service shutdown ends the wait without acknowledging events. The socket request is bounded below its transport timeout, and shutdown aborts waits before draining connections.

Consumer cursors are separate per consumer and exact project/job scope. Reading/waiting never acknowledges work. After processing, `checkpointRunEvents` requires the previous offset and a monotonic new cursor; concurrent stale updates, rewinds and future offsets conflict. An identical acknowledgement is idempotent. Store the page's cursor after processing to obtain replay after a disconnect; delivery/processing is not promised exactly once. There is no automatic event pruning/retention policy yet.

Events contain IDs, bounded state and safe references, not response text, report bodies, credentials, arbitrary environment or terminal transcripts. `run inspect` includes the current report and latest ten responses/continuations; durable records and cursor history remain in state. Library lookups retrieve older reports/responses by exact key/ID without relying on those display limits. Runtime wake-up, external notifications, dashboards and automatic remedies remain separate work.

## Verification

Disposable repositories/state, private sockets and injected runtimes exercise duplicate/invalid/stale reports, exact review scope, artifacts, disconnect/reconnect cursors, bounded waiting, decision/resume, lost acknowledgement, cancellation during preflight, verified native interrupt, changed binding, retained work and migration backfill. Routine checks never launch real agents, mutate GitHub or use user-project runtime resources.

## Implementation publication events

The explicit [handoff workflow](handoff.md) appends `handoff_prepared`, `handoff_abandoned` and `handoff_accepted` events transactionally with the corresponding publication journal mutations. Acceptance includes the exact target and nullable follow-up review ID. These events do not change the accepted implementation outcome, prove worker shutdown or release resources. A saved requested review remains distinct from a submitted/dispatched review job.

## Explicit historical review acceptance

`run report --accept-historical-review` can retain a reviewed commit-bound proposal after a positively identified remote head/base change. Normal acceptance stays strict. All assignment, acknowledged delivery, clean local SHA, artifact and transaction checks remain required; provider failures do not grant historical acceptance. The optional request flag and `evidence.historicalReview: true` preserve older saved bytes when absent. Historical findings grant neither current readiness nor publication. See [review results](review-results.md).
