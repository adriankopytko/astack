# Supervised cleanup pilot — 2026-10-26

The cleanup flow passed against `b0cc372` plus the cancellation bookkeeping fix found during this pilot. Verification used two fresh Astack-owned checkouts in the retained private disposable repository. One ran a real Codex worker through Herdr; the other was cancelled before any worker launch and used for controlled cleanup-controller interruption. No production project, GitHub publication, merge, branch deletion or force removal was involved.

## Real worker and automatic cleanup

1. Under coordinator ownership, the existing private pilot state migrated to the cleanup schema. All four prior worker runs were snapshotted. A new checkout started at a retained full commit SHA; no historical checkout or branch was reused as the new task checkout.
2. Astack launched one real Codex worker, visible in its dedicated grouped Herdr workspace. Saved worker name, pane, terminal, foreground cwd, process tree and one explicitly selected Codex session file were verified. The task ran the existing Node tests and three duration-formatter assertions without changing files or starting services. Its structured completed report was accepted through `run collect-report`; the four native resource holds remained retained.
3. A cleanup request explicitly selected `automatic` and `not_required` publication, with a 45-second retention deadline. The service, started without cleanup authority, saved it suspended. Restarting with `--cleanup` did not resume it. Explicit resume before the deadline left the checkout intact and the plan requested.
4. Without a service wake or another prompt, the retention timer advanced the plan to `blocked: resources_retained` after the deadline. The completed worker and all four holds were still present. Report acceptance and retention expiration did not establish shutdown.
5. The coordinator was stopped. After recording exact process/descendant/group identities, the host gracefully exited the completed worker, verified those processes/groups absent and its owned shell restored, and closed only its worker workspace. Fresh Herdr absence and checkout-cwd inspection supplemented the host's shutdown attestations. The persistent primary project space remained present. No project services had been started.
6. Offline `cleanup execute`, with the complete exact shutdown request and host attestations, reconciled the four matching native holds but returned `blocked: dirty` for an injected untracked sentinel. The file and accepted report were preserved. After the host removed only that injected file, another execution returned `blocked: ignored_files` for an ignored sentinel. Its bytes survived; the temporary local Git ignore rule was restored exactly and only the injected sentinel was removed.
7. Starting the opted-in cleanup service then removed the eligible checkout automatically. Astack recorded completed cleanup and removed the Git worktree registration through ordinary owned removal. Its task branch still references the frozen full SHA, and the original accepted report, runtime identity and acknowledged generation-zero input remain unchanged.

## Cancellation gap found and fixed

The second checkout's task was accepted with runtime adapters disabled, then cancelled before any launch claim. Its run correctly became cancelled with no native worker or retained worker resources. Cleanup nonetheless returned `resource_in_use`: the initial launch effect remained pending and the attempt remained unresolved. The removal guard correctly refused removal; the intended interruption hook was not reached and no Git removal ran.

The fix closes only an exact sole unclaimed pending initial worker-launch effect and records its cancelled terminal result transactionally with cancellation/events. The effect has a distinct local resolution claim; the service entry retains `claim: null`, so this does not fabricate worker execution/capacity evidence. Claimed, unknown or additional effects never qualify, and independently claimed launches remain cancellation-requested. Service reads expose actual saved effect claims, and dispatch refuses claimed/resolved effects.

An explicit repeat of the original saved `run cancel` key settled this legacy pilot attempt through normal operations. A second repeat was unchanged. No database repair, replacement key, provider call or resource release was used. Isolated regressions cover normal cleanup after never-launched cancellation, explicit legacy settlement/idempotency, preservation of an independently claimed launch, and rollback of effect/result/cancellation when event persistence fails.

## Interrupted cleanup controller

1. After cancellation settlement, the second checkout's manual cleanup was explicitly resumed. A trusted injected wrapper around the existing Git removal port paused the host controller after cleanup `started` and worktree `removing` were committed, but before the provider removal call began. The checkout and branch remained present.
2. A competing cleanup controller was refused by coordinator ownership. The host verified the exact paused process and absence of children, recorded its pre-provider boundary, then killed only that disposable controller. The execution exited 137. This was a supervised known termination, not an age/PID-absence inference.
3. Restarting the service preserved the exact started cleanup revision and checkout. Explicit wake added no events or removal. Ordinary resume was rejected; after service shutdown, ordinary execute was also rejected pending reconciliation.
4. With the original controller/children stopped and coordinator excluded, `cleanup reconcile --writers-stopped` inspected the exact saved worktree operation and restored the request without removing its checkout. A separate `cleanup execute` then completed ordinary removal and retained the branch at its frozen commit.

This exercises controller loss before the Git effect. Lost acknowledgements after an actual Git removal remain covered by isolated fault injection; this live pilot does not claim that additional failure point.

## Final audit

- Both new cleanup plans are completed and both owned checkouts/Git registrations are absent. The first removal was performed by the service executor; the second by explicit Astack cleanup after reconciliation. The host did not remove either worktree directly.
- Both task branches, owned marker containers, historical registrations, accepted reports, input receipts, runtime records and private audit evidence remain retained. The source repository is clean and its temporary ignore rule is restored byte-for-byte.
- All six worker runs in this disposable state are terminal, with zero retained resources and resolved attempts. The four pre-existing runs compare exactly to their baseline snapshots.
- A final runtime-enabled coordinator restart plus explicit wake added zero events and launched no worker. Both completed cleanup retries returned existing records and added no events. The event high-watermark remained 87.
- No pilot agent, cleanup controller or coordinator remains active. The private service endpoint was removed and coordinator ownership could be acquired. The primary Herdr project space remains present.
- No GitHub reads/writes or new CI activity were needed for cleanup. The existing private remote repository and previous audit material were preserved.

Raw identities, process evidence, state snapshots and command receipts are retained privately. This report deliberately omits machine-specific paths and provider handles.

## Scope and next step

The pilot verifies explicit retention, service disable/resume, timer-driven execution, native shutdown gating, untracked/ignored preservation, accepted-report retention, actual normal removal, controller interruption/recovery, restart stability and idempotency. It does not add automatic worker/workspace/service teardown, port reclamation, integration-environment provisioning or artifact/history garbage collection. Host shutdown verification remains explicit; unknown resource holds still block cleanup.

A future owned service/port lifecycle adapter must supply independently verified stop/release evidence to the same cleanup operation.

## Repository validation

`pnpm check` passed all **387 tests** with zero failures, including the four new unclaimed-cancellation regressions and the extended queued-cancellation check. Build, typecheck, typed lint, formatting and resolved module boundaries passed. Formatting was checked again after adding this report.
