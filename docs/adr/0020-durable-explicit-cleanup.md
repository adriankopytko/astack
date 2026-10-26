# ADR 0020: Durable explicit cleanup with opt-in execution

Status: Accepted

## Context

A task can be completed and published while worker resources or its checkout remain retained. Cleanup must neither block follow-up review nor infer that report acceptance, UI idleness or confirmed publication stopped a worker and its descendants. Our current native provider cannot prove arbitrary descendant/service shutdown. Provisioning and lifecycle hooks remain future operations.

## Decision

Persist one immutable cleanup request per delegated run, with frozen assignment/report/SHA, host-selected retention deadline, publication requirement and an explicit automatic-execution option. Store requested/started/blocked/suspended/completed/cancelled evidence and local events independently of workflow outcomes. Reuse existing run shutdown verification and owned worktree removal/reconciliation. Persist a nonexpiring claim before effects; validate authority and observed SHA in the removal-intent transaction, and reject new checkout assignments while cleanup is reserved.

A service only executes saved automatic requests with its explicit `--cleanup` flag. Local wakes and retention timers drive execution; there is no provider/GitHub polling or automatic backlog enrollment. Starting without authority suspends eligible requests, and restoring authority requires explicit resume. Worker shutdown attestations are always supplied by a trusted host; automation only consumes already established shutdown evidence and freshly verifies exact provider absence. Unknown service/resource ownership remains a blocker.

Keep offline execute/reconcile under the existing kernel coordinator lock from before database migration until effects drain. Add only `src/cli/cleanup.ts` → `src/host/cleanup.ts` to the narrow CLI composition exceptions; other CLI/host directions stay prohibited. The service uses the same application operations and accepts request/control RPCs, with injected shutdown verification available to library hosts.

## Consequences

The orchestrator can request cleanup immediately after a terminal result, retain it until an explicit deadline, and inspect blockers independently of review. Ordinary cleanup preserves dirty/ignored/untracked files, task branches, primary spaces and unknown holds. Pending removal never replays by age, shutdown flags or a new key; operation-bound writer-excluded reconciliation verifies partial effects without sending them again.

This is automatic safe checkout removal after verified shutdown, not automatic native process/service teardown. Owned service stop/port release and native layout termination require future capable adapters and independently verifiable shutdown evidence. Dedicated task checkouts are required; shared delegated-run checkouts are conservatively blocked. Marker containers, branches, reports, logs and journal history are not garbage-collected by this operation.
