# Durable owned checkout cleanup

Cleanup is independent of accepted task outcome, publication, CI and follow-up review. `cleanup` operations retain one explicit, immutable request per delegated run, freeze its project/repository/attempt/checkout/worktree/branch/full SHA/report, and append `cleanup_changed` events transactionally with each mutation. Migration 15 adds the journal without changing existing reports or launching effects.

## Inputs and authority

`requestCleanup` accepts schemaVersion 1, jobId, stable key, `notBefore` (Unix milliseconds), `automatic` (default false), and `publication` (`required` by default, or host-selected `not_required`). The run must be terminal and assigned to a ready owned task checkout. A primary checkout cannot be selected. Checkout sharing between delegated runs is conservatively rejected; give each task a dedicated checkout. Repeating the same request returns the same plan; changing the key or retention policy cannot bypass it. Suspend indefinitely or cancel an unstarted plan to retain its resources. A cancelled plan cannot be replaced with another key.

These are trusted host controls, never repository configuration or worker proposals. Public application functions receive stores, a trusted clock, explicit working directory, existing worktree dependencies and an optional `RunShutdownVerifier`. Imports perform no IO. Hosts must hold coordinator ownership throughout effects and drain them before releasing it. Use `executeLocalCleanup` for the bundled offline path; it locks before writable open/migration. The service owns the same lock for its lifetime.

The minimum retention deadline is immutable. Expiration permits inspection, not shutdown, release or deletion. Automatic execution requires both `automatic: true` on the saved request and the service's `--cleanup` flag. Nothing enrolls historical runs or new terminal reports implicitly. The orchestrator explicitly requests cleanup for each eligible run. Repository settings cannot enable it.

## Commands

```sh
astack cleanup request <job-id> --key cleanup-v1 --not-before <unix-ms> [--automatic] [--allow-unpublished] --json
astack cleanup inspect <job-id> --json
astack cleanup execute <job-id> --revision <cleanup-revision> --json
astack cleanup suspend <job-id> --revision <cleanup-revision> --json
astack cleanup resume <job-id> --revision <cleanup-revision> --json
astack cleanup cancel <job-id> --revision <cleanup-revision> --json
astack cleanup reconcile <job-id> --revision <started-revision> --writers-stopped --json
astack service run --cleanup
```

Request/control commands use the running coordinator when it owns state, otherwise the offline locked host path. Inspection opens state read-only and makes no provider calls. Execute/reconcile are offline; stop the service first. CLI exit 1 includes a persisted blocked or started/uncertain plan; inspect it before taking another action.

A service started without `--cleanup` suspends eligible automatic backlog. New automatic requests received by that service are also suspended. Restoring the flag does not resume them; use the exact saved revision. Resume of an automatic plan through a disabled service is rejected. Started claims stay started; disabling execution never establishes shutdown or discards uncertain work. Effects already authorized before a control can complete; suspended/cancelled requests cannot acquire a new removal claim.

## Shutdown and resource verification

Accepted reports and publication results do not prove shutdown. Before removal, the operation requires no retained run resources or unresolved continuations. A claimed worker also needs a saved run shutdown reconciliation and a fresh verification of the exact saved worker/resource bindings. The built-in Codex/Herdr verifier checks saved transport identity and absence of the exact owned worker layout/agent, while retaining the original host attestations concerning stopped descendants, services and controllers. It preserves primary spaces and never closes a workspace or sends a guessed exit command.

Use the existing `run reconcile` operation first, or supply the complete shutdown request to offline cleanup execution:

```sh
astack cleanup execute <job-id> --revision <cleanup-revision> \
  --attempt <attempt-id> --launch <launch-id> --run-revision <run-revision> \
  --shutdown-key shutdown-v1 --worker-stopped --services-stopped --writers-stopped --json
```

All shutdown fields and truthful host attestations are required together. Obtain independent host evidence first; idle/done, Escape, age and PID absence are insufficient. A mismatched job/attempt/launch/revision or unavailable provider blocks execution. Automatic execution never invents these attestations. Without saved shutdown evidence it remains blocked, with no recurring provider polling; after offline reconciliation, restart/wake the enabled executor.

Shared resource allocation and explicit [lifecycle hooks](hooks.md) are implemented separately. Cleanup does not automatically invoke them, stop arbitrary services, terminate workers, close Herdr layouts, reclaim ports or remove retained integration environments. Unknown resource holds block removal. A future owner-aware shutdown adapter must establish service/process shutdown before releasing matching holds; it can then feed this same cleanup operation. Do not release a hold or pass a shutdown flag just to make cleanup proceed.

## Removal gates and effects

By default cleanup requires accepted implementation publication at the frozen report/head, or a confirmed review publication for that report. This protects a checkout still needed by explicit publication. `--allow-unpublished` explicitly permits workflows that retain local branches/reports without publishing (including failed or cancelled runs without publication); an existing prepared/unknown publication still blocks. Confirmed legacy host attempts needing settlement use their existing writer-excluded publication reconciliation, never SQL editing or a new send key. Cleanup makes no GitHub requests and does not publish, merge, change issues or gate review readiness.

After retention, saved assignment/publication and fresh shutdown checks, the operation persists `started`. In the same transaction that begins worktree removal, it rechecks the cleanup revision/authority, exact observed HEAD, saved terminal source and publication. New service assignments are rejected for a checkout with an uncancelled cleanup intent or a non-ready managed worktree. Existing idempotent submissions remain inspectable. Worktree removal additionally checks every associated job's attempts/resources and dependent worktrees.

The existing removal primitive performs fresh ownership/marker, filesystem identity, branch/SHA, Git membership, locks, tracked/untracked/ignored files, source identity and branch-retention checks before ordinary `git worktree remove`. It verifies absence afterward. No force, prune, branch deletion, recursive container deletion, primary workspace closure, credential handling or environment overwrite is introduced. Cleanup runs from outside the target checkout. Trusted cooperating writers remain necessary: SQLite and Git/filesystem/provider effects cannot be made one atomic transaction.

## Results, failures and recovery

Phases are `requested`, `started`, `blocked`, `suspended`, `completed`, `cancelled`. Block reasons include retention, missing publication (`cleanup_blocked`), resources_retained, shutdown_required/unverified, dirty, ignored_files, resource_in_use and stale ownership/assignment evidence. Accepted task/review outcomes remain unchanged. Repeating an unchanged blocker does not append duplicate events. Blocked plans can be inspected or explicitly retried after fixing the cause. Automatic plans retry only on local wake/startup or their retention timer; no cron, GitHub scan or periodic shutdown probe is installed.

A claim has no lease timeout. Pending/uncertain removal remains `started`; restart, age, a different key and resume never replay it. Stop/exclude the original writer and its children before `cleanup reconcile --writers-stopped`. Reconciliation binds the exact cleanup revision and current worktree operation, invokes inspect-only worktree reconciliation when necessary, and verifies absence plus retained branch/commit before completing. If the checkout is still verified present, it restores the cleanup request; a later explicit execution performs all checks again. It never executes Git removal itself. Dirty, unowned, replaced or ambiguous resources remain preserved. Uncertain SQLite commits require reopening and inspecting the saved stable IDs.

Cancellation before a claim performs no removal; after a claim the worktree primitive preserves pending intent or records verified completion. Service shutdown aborts and drains its executor under coordinator ownership. `completed` means the owned checkout's absence was verified and recorded; its task branch, container/marker, historical registration, reports and event journal remain for audit. File/log/history garbage collection remains separate future work.

## Never-launched cancellations

A run cancelled before its launch was ever claimed can clean up without native shutdown evidence. Its cancellation operation must still close the exact unclaimed launch effect and terminalize the attempt; cancelled run status alone is insufficient. If a legacy cancellation leaves `resource_in_use`, explicitly repeat its original `run cancel <job-id> --key <same-key>` through the owning service. Only a never-claimed, single pending initial launch qualifies; unknown/claimed/additional effects remain blocked. This performs no provider effects or resource release. See [run cancellation](runs.md).

## Allocated application resources

Shared [port/name allocations](resources.md) retain ordinary attempt resource holds. Checkout cleanup and generic worker reconciliation cannot bypass those holds. Independently stop/verify the owned application services and original startup controllers, then explicitly release the exact allocation revision/startup receipt with fresh endpoint evidence. Native worker reconciliation and worktree removal remain separate; retained environments keep both their allocation and cleanup blocker.

Hook invocations retain their own guarded cleanup holds even after a successful command exit. Exclude a crashed original hook writer explicitly if needed, run approved teardown, independently verify shutdown, release its referenced allocations, then reconcile its exact hook revision. Neither command success nor original-process-group absence proves escaped services stopped. Existing native worker reconciliation and worktree removal remain separate.
