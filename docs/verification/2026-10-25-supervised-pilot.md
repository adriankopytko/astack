# Supervised live-provider pilot — 2026-10-25

The main orchestration loop passed against commit `85fafd1`. The publication-attempt cleanup gap discovered during the pilot was subsequently fixed and all four managed checkouts were removed normally. This was a private disposable Node project with synthetic source, real GitHub PRs/checks/review comments, and four real Codex workers in Herdr. It did not use a production project or publish internal project details.

## Verified flow

1. Astack accepted an implementation in an owned checkout and launched one visible worker in the dedicated project group. Codex's initial trust dialog required the user's decision; Astack retained the original pending launch without sending the assignment or creating a replacement. Once trusted, the same worker received its original assignment.
2. The task deliberately produced a faulty formatter with 24-hour wrapping, so the independent reviewer would have a deterministic functional defect to find. Baseline tests passed; independent host checks confirmed the seeded violation. This was intentional fault injection, not a claim of specification correctness.
3. The worker returned a structured decision checkpoint. The host inspected and committed the fixture, then used one recorded decision response and acknowledged continuation to obtain its completed clean-SHA report. The host performed Git commits; this pilot does not establish autonomous worker committing.
4. After verified worker/descendant shutdown and reconciliation, Astack pushed the exact commit, created a PR and atomically recorded an authorized review follow-up. Both effects were confirmed against live GitHub.
5. Pending real CI produced a persisted `watching` subscription and `waiting` plan with no review job or reviewer agent. Restarting the coordinator preserved the same plan, CI subscription and generation. The observer followed its saved backoff schedule; the orchestrator waited on local events rather than adding GitHub polling.
6. Passing CI woke the follow-up dispatcher and coordinator without a manual wake: `ci_observed: ready` → `follow_up_queued` → `follow_up_dispatched`. Exactly one reviewer launched in a distinct owned checkout and visible worker workspace.
7. The reviewer independently found one high-severity defect: duration hours wrapped at 24. Its first structured report passed validation, including the numeric finding line. The result was accepted and published as a commit-bound GitHub `COMMENT` review. Repeating publication returned the same confirmed effect; GitHub had one matching marked review.
8. `implement submit --fix-of` accepted a new implementation with the original review job/attempt/report/digest/SHA and selected finding index in its saved submission. A fresh owned checkout was used. The fix removed the modulo and added duration and safe-integer regressions. Four project tests and all 104 independent checks passed. The new regressions failed against a copy of the original source.
9. After host inspection/commit and same-worker continuation, a new handoff published the fixed SHA in a second PR. This verifies the current fresh-publication cycle, not updating the original PR in place. A separate reviewer started only after that commit's real CI passed and returned zero findings. Its result was also accepted and published as a commit-bound comment review.
10. Final GitHub inspection found exactly two pilot PRs, one marked review per PR, and successful CI at both exact SHAs. Neither PR was merged or approved. The original accepted finding remained attached to the original SHA; it was not overwritten by the fix or second review.
11. All four workers exited gracefully. Recorded worker/descendant processes and groups were verified absent, their owned worker workspaces were closed, and exact shutdown reconciliation released every worker hold. Each run has one claim, one reconciliation and its acknowledged original input at generation zero. The empty primary project space was preserved.
12. A final runtime-enabled coordinator restart and explicit wake preserved all four reports, launch IDs, control revisions and input receipts. The event high-watermark stayed at 55 and no pilot agent appeared. The coordinator was then stopped.

Committed source/tests were archived privately; the fixed archive independently passed its four project tests and all 104 host checks again.

## Cleanup blocker found during the pilot

Normal `worktree remove` returned `resource_in_use` for all four clean owned checkouts. The worker attempts were resolved and had zero retained resources. Their separate `implementation-handoff` and `review-result-publication` attempts remained unresolved even though all their effects were confirmed. The removal guard correctly preserves a checkout associated with any unresolved attempt.

No force removal, branch deletion or direct database repair was performed. The four clean checkouts, branches, accepted reports, publication receipts and private audit evidence were retained. There are no running pilot agents or coordinator.

## Cleanup fix and live recovery

Successful host publications now receive terminal results after exact effect/receipt and source/job/attempt/branch/SHA validation. Handoff acceptance and finalization are atomic. Review publication finalization is a separate local transaction after durable effect confirmation; an interrupted transaction can be retried using the same saved confirmed receipt. `publication_finalized` is appended only when a terminal result is first recorded. Pending/unknown effects stay unresolved, and reads/startup do not repair old records.

Existing writer-excluded `handoff reconcile` and `review result reconcile` commands settled all four pilot host attempts without new pushes, POSTs or direct database repair. The source worker reports, claims, original input receipts and resource reconciliations stayed unchanged. Exactly four finalization events advanced the event cursor from 55 to 59. Retrying all four reconciliations after checkout removal and PR closure added no event and succeeded without live checkout/provider access.

Normal `worktree remove` then removed all four managed checkouts and their Git worktree registrations. Task branches, reports, publication receipts, the private repository and audit evidence were preserved. The two disposable PRs were closed without merge or branch deletion, and no CI runs remain active. There are no running pilot agents or coordinator; the empty primary project space is preserved.

A further runtime-enabled coordinator restart after checkout removal preserved all original reports, launch IDs, control revisions and input receipts. Its event cursor stayed at 59 and no pilot agent appeared. The coordinator was stopped afterward.

Regression coverage includes new and legacy host completion, uncertain effects remaining unresolved, rollback after remote confirmation, no duplicate result/events on retry, and actual normal removal with branch retention. The removal guard also checks retained resources for every job using a checkout, including jobs accepted after an initially unbound worktree was prepared. Finalizing a host publication does not establish worker quiescence or release worker holds. Broader cleanup orchestration remains tracked in [issue #28](https://github.com/adriankopytko/astack/issues/28).

## Boundaries

This pilot does not verify two technology profiles, concurrent projects, port/service allocation, project initialization/adoption, lifecycle hooks, executed verification gates, automatic fix loops, merge policy or same-PR fix publication. Host setup, commits, shutdown attestations and publication authorization remained explicit. The initial SSH push failed host-key verification; the disposable repository used authenticated HTTPS without changing global Git configuration or accepting an unknown SSH host key.

Live-provider evidence is retained privately. Reusable controlled behavior continues to be covered by the 366-test isolated verification; the follow-up fix additionally verified legacy publication settlement and complete managed-checkout cleanup against the same live pilot records.

Follow-up verification: `pnpm check` passed all 371 tests with zero failures, including five publication-completion/cleanup regressions, plus build, types, typed lint, formatting and resolved module boundaries. Live recovery left all eight worker/host attempts terminal, all four managed checkouts removed, both test PRs closed and no active pilot workers, coordinator or CI runs. Branches, reports, receipts, the private audit repository and persistent primary project space remain preserved.
