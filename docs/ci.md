# Targeted CI observation

## Scope and authority

Issue #25 adds persistent, shared CI observations for already accepted review work. The CI observer never discovers unrelated PRs, creates a review job, starts an agent, publishes findings or merges. Its progress can wake the separately opted-in [follow-up dispatcher](automatic-review.md). The default service has no CI observer. `service run --observe-ci` explicitly enables the scheduler; `ci watch` separately authorizes waiting for one persisted source.

A source is either an existing manual review job or an accepted implementation handoff containing an explicitly authorized follow-up review. A handoff with `review: null` cannot be watched. Arbitrary repository/PR/SHA targets are not accepted by the enrollment operation. The saved source supplies the exact target and gate; enrollment and every read revalidate it against current trusted host policy and explicit registered project identity.

The HTTP adapter runs in the target project's registered primary checkout. Its path/checkout/repository/policy identities are bound at enrollment and rechecked. It never derives the target from the service cwd, ambient Herdr pane, or the presence of a user-managed remote. Cleanup of the implementation worktree does not remove this primary context.

## Commands

```sh
astack service run --observe-ci
astack ci watch --handoff <implementation-job-id> --handoff-key publish-v1 --key wait-v1 --timeout-ms 3600000 --json
astack ci watch --review <review-job-id> --key wait-v1 --json
astack ci inspect <ci-request-id> --json
astack ci list --project <project-id> --limit 20 --json
astack ci suspend <ci-request-id> --revision <current-revision> --json
astack ci resume <ci-request-id> --revision <current-revision> --timeout-ms 3600000 --json
astack ci cancel <ci-request-id> --revision <current-revision> --json
astack ci complete <ci-request-id> --revision <current-revision> --json
astack ci wake --json
```

All commands honor `--state-directory`. Enrollment and controls use the owning service. Inspect/list work offline against existing migrated state, never querying GitHub. Select exactly one `--handoff` or `--review`; `--handoff-key` applies only to handoffs. A request key is immutable. Exact repeats return the saved request; another active key for the same project/source conflicts instead of multiplying watchers.

The deadline defaults to one hour and supports 1,000–604,800,000 ms. Suspend/cancel/complete/resume require the exact saved revision. Explicit resume revalidates original source/policy/context, establishes a new deadline and requests a fresh observation; it never retargets a changed SHA. Cancelled/completed CI requests are terminal. `complete` ends local tracking; it does not establish a successful review or release resources. Controls during an in-flight read invalidate its captured request revision.

`ci wake` only acknowledges that the enabled observer was woken; it does not report a completed observation, bypass a future schedule/budget, or launch an agent. With observation disabled it rejects. Enrollment can remain durably watching while the service observer is disabled. Restarting an enabled observer resumes these previously authorized reads; this is separate from the separate [automatic-review enable/resume policy](automatic-review.md).

## State and evidence

Migration 12 creates `ci_requests`, shared `ci_targets`, and `ci_budgets`. Each request retains source identity, project/repository/primary-checkout identity, policy digest, target, gate, deadline, revision, phase and reason. The shared key is the canonical host/repository/PR/full SHA, independent of which project or gate consumes it. Up to 128 active requests can share a target.

`ci_requested`, `ci_controlled` and `ci_observed` run events are appended transactionally with request mutations. They contain IDs/SHA/phase/reason/revision rather than transcripts, credentials or provider diagnostics. Use the existing monotonic event/cursor API for durable arrival processing. List pagination uses sorted IDs and is a browsable listing, not an arrival cursor.

| Phase       | Meaning                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watching`  | Waiting for a due read, budget, transient-error retry, pending checks or missing check evidence                                                                              |
| `ready`     | A matching snapshot passed this request's gate at its observation time; observation stops                                                                                    |
| `blocked`   | Explicit action is required: failed/skipped/cancelled checks, changed target/base, inaccessible context/policy, unsupported/incomplete evidence, closed/draft PR or deadline |
| `suspended` | Host explicitly paused observation                                                                                                                                           |
| `cancelled` | Host cancelled tracking, or the source review was cancelled                                                                                                                  |
| `completed` | Host ended tracking, or the source review completed                                                                                                                          |

A completed or decision-blocked source review is checked before its next provider read. Handoff sources refer to the saved authorized follow-up, not the already completed implementer. Failed or needs-decision sources block observation. Resuming a blocked request is explicit; a repaired check or changed host policy does not itself restart it. Policy/context drift requires a newly validated enrollment if the original binding can no longer be restored.

Shared observations retain the latest successful snapshot/observation time, latest error, next refresh, backoff streak and any in-flight claim. A later failed read preserves the historical successful snapshot with its old timestamp and a separate error. It cannot turn that old snapshot into ready evidence. Request phases apply their own required-check policy to the same result. A ready record is historical: checks may rerun or a PR may move afterward.

## Gates and fresh dispatch

The existing bracketed GitHub reader checks the exact PR head before and after bounded check-run/status pagination. Wrong attribution/SHA, changed PR head, duplicate/ambiguous names, malformed output and incomplete reads reject rather than synthesize success. Each completed snapshot must match the shared target and fall within the claimed read interval.

Required names must exist and pass. With no selected names, all observed checks must pass and at least one must exist. Missing checks remain watching until the deadline; failed/skipped/cancelled checks block. Pending checks remain watching. Draft/closed/merged PRs block. For an already accepted manual review, a changed base SHA also blocks its saved diff scope.

An explicit no-CI policy is supported only when both the gate sets `allowNoChecks: true` and private host configuration permits `execution.review.allowNoChecks: true`. `review submit --allow-no-checks` supplies the explicit gate request; accepted handoff follow-up gates can carry the same field. This permits only a completely empty check set when no required names were selected. It does not make skipped, failing, pending or missing selected checks pass. Existing `overrideReason` retains its separate host permission and preserves actual check evidence. Neither permission can bypass identity or draft/closed PR checks.

The optional gate/host fields remain absent on older records, preserving old configuration digests and reconstructed prompt bytes. Repository proposals cannot grant either permission.

The existing review workflow still checks live target/base/readiness before capacity claim, first input and report acceptance. The CI cache is never substituted for those checks. Use `service wake` to reconsider an existing manual review job after readiness; the [follow-up dispatcher](automatic-review.md) can separately enroll an owned CI generation and queue authorized review. Observing CI creates no idle worker.

## Schedules, budgets and restarts

Library hosts configure the scheduler with `startLocalService(..., { ci: { policy, reader? } })`. The CLI's opt-in uses these defaults:

| Setting                            | Default                                         |
| ---------------------------------- | ----------------------------------------------- |
| Base interval                      | 30 seconds                                      |
| Maximum exponential interval       | 5 minutes, plus 0–25% positive jitter           |
| Reserved API slots per observation | 10                                              |
| Shared host budget                 | 60 slots per 60-second window                   |
| Read claim                         | 60 seconds                                      |
| Targets per pass                   | 4                                               |
| Provider deadline                  | 30 seconds aggregate, 10 seconds per subprocess |

The service sleeps until a saved refresh/claim expiry/deadline is due, with local wake checks capped at 60 seconds. It has no timer when nothing is watching. Local wake checks do not imply provider reads. New enrollments/controls explicitly wake it. Each pass expires at most 256 overdue requests and processes a bounded number of due shared targets.

A transaction claims a target, captures participating request revisions and reserves its full maximum request cost from a host-wide budget before any provider read. Page reads and the bracketing PR observations all count toward the provider's hard `maxRequests` ceiling. This bounds `gh api` subprocess invocations, not provider-internal HTTP retries or GitHub's point accounting. Ordinary manual review/report/publication calls have their own bounds and are outside this scheduler budget.

Unused slots are deliberately not refunded, including after cancellation/crash. A policy decrease cannot restore already consumed capacity within a window. All managed projects targeting a host share its budget. A rate-limit response also persists a host-wide cooldown using sanitized numeric retry/reset hints. Other due targets defer behind it. No hint is interpreted as permission to retry a write.

Pending/missing checks and transient provider failures back off exponentially, with persisted positive jitter; rate-limit hints are honored as lower bounds. Auth/access, invalid/partial-output/page-budget and changed-target errors block for explicit investigation/resume. The next refresh and streak survive restart.

Unexpired read claims remain excluded after restart. An expired claim can be replaced for a new **read**, consuming a new budget reservation and token. Late results from the old token cannot settle the new claim. Reads are repeatable; this does not relax pending/unknown write recovery for launch/input/push/publication. Newly joined or resumed request revisions cannot be settled by an older read's participant list.

## Failure and cancellation contracts

Public operations are `watchCi`, `inspectCi`, `listCi`, `controlCi` and `observeCi`, with schemas and named ports in the library. Invalid requests reject before a provider call. Local writes return the existing persisted/rejected/uncertain contract; after uncertain persistence, reopen and inspect stable IDs. Do not assume enrollment, claim, budget or settlement was rolled back.

Provider exceptions retain sanitized failure evidence and an appropriate retry schedule or blocker. Same-host rate limits do not cause a tight retry loop. Each result is revalidated against source/policy/context before applying request decisions. Shared snapshot, schedule, matching request decisions and events settle atomically. A concurrently controlled request is skipped through revision comparison.

Service shutdown cancels the current bounded read, drains it and the worker coordinator, then closes state and releases ownership. It preserves active CI requests for restart and never terminates a worker as CI cleanup. No positive readiness is accepted from a cancelled observer pass. A custom injected reader must honor cancellation and its bounds; the host cannot prove termination of escaped provider descendants from process-group evidence alone.

Writable service startup now takes coordinator ownership before opening/migrating the main database. Initial private directory/marker/bootstrap-file preparation remains separate. Read-only inspect/list do not bootstrap or migrate.

## Verification status

`tests/ci-observation.test.ts` exercises persisted CI operations with disposable Git repositories, real SQLite state, a controlled clock and injected provider responses. Coverage includes shared target reads with independent consumer gates; missing, pending, failing, skipped and cancelled checks; explicit no-CI permission; rate-limit cooldowns, hard request budgets and deadlines; reopened state; suspension, cancellation and stale claim rejection; policy changes; and historical snapshots after failed reads. Transport fixtures also verify that pagination and bracketing reads obey the request ceiling.

The local-service integration in `tests/automatic-review.test.ts` checks that CI progress wakes the follow-up dispatcher without manual observation/dispatch ticks. These fixtures use fake providers and do not establish live GitHub or Herdr compatibility. Supervised live-provider verification remains separate.

Initial verification on 2026-10-25 passed all 31 new CI/automatic-review test cases, but two full runs each finished at 357/358 because different existing tests encountered `git_failed`. Diagnostic work reproduced a successful Git exit being classified as `descendants_remaining` after a permission-sensitive process-group probe, even though final group absence was verified. The [process runner](process-runner.md#execution-and-shutdown-evidence) now waits within the existing deadline when a post-exit probe is unknown, rather than treating uncertainty as confirmed descendants. Two deterministic regression cases fail against the old behavior and pass with the fix; persistent uncertainty remains bounded and cannot establish success. No Git invocation is retried. A concurrent disposable implementation/worktree probe passed 20 setups with the fix.

After the fix, `pnpm check` passed all 360 tests, including the previously failing implementation/configuration cases, together with build, TypeScript, typed lint, formatting and resolved module boundaries.

## Owned automatic waits

A follow-up dispatcher enrollment includes an optional `automaticReviewPlanId`. Its saved plan, current project control revision, executor capability, source and canonical CI generation are checked before observation and atomically at new CI intent acceptance. Manual enrollments omit this field and are unaffected by project automation controls. Control automatic waits through their plan; new generations/revisions cannot consume late results from a previous wait. The CI observer's optional progress callback is a host composition hook, not reviewer dispatch authority by itself.
