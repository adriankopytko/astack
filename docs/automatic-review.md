# Explicit after-handoff review dispatch

## Scope

Issue #26 connects an accepted implementation handoff's authorized review request to CI observation and the existing worker queue. Manual review remains the default. A handoff with `review: null` creates no automatic plan or watcher, and ordinary `review submit` creates no automatic plan. There is no PR scanner, automatic fix loop, findings publication or merge.

The orchestrator prepares a dedicated clean owned reviewer checkout at the exact handoff SHA and explicitly attaches it to the follow-up. Checkout creation, fetching objects, dependency/service setup and cleanup remain their existing explicit operations. The implementation checkout cannot be reused. This first dispatcher supports static review, with no integration resources.

## Opt-in and commands

Three decisions are separate:

1. The handoff explicitly authorizes a follow-up target, gate and instruction paths.
2. The host enables project automation and attaches the dedicated owned review checkout.
3. The service enables its follow-up executor and CI observer.

```sh
astack service run --observe-ci --after-handoff-review --codex-herdr
astack review automation inspect --project <project-id> --json
astack review automation enable --project <project-id> --revision 0 --json
# Prepare a distinct owned checkout using worktree prepare at the accepted full head SHA.
astack review follow-up enqueue --handoff <implementation-job-id> --handoff-key publish-v1 --checkout <reviewer-checkout-id> --branch <reviewer-branch> --commit <full-head-sha> --json
astack review follow-up list --project <project-id> --json
astack review follow-up inspect <plan-id> --json
astack review automation disable --project <project-id> --revision <settings-revision> --json
astack review follow-up resume <plan-id> --revision <plan-revision> --json
```

`--after-handoff-review` requires `--observe-ci`. `--codex-herdr` independently enables the built-in agent runtime; library hosts can install another approved review-capable runtime. Without a runtime the review job remains queued/blocked rather than starting an agent by another path. Runtime adapters for automatic reviews must implement fresh preflight and preserve the supplied authorization gates.

All commands honor `--state-directory`. Inspection/listing work offline against existing migrated state. Mutations use the owning service. `enable`/`disable` require the exact project settings revision; follow-up `suspend`, `resume` and `cancel` require the exact plan revision. Enqueue accepts `--timeout-ms` for each CI generation, default one hour and bounded to one second–seven days. There is one immutable plan per accepted follow-up ID; changing its checkout/branch/SHA under the same plan rejects.

Enqueue while project automation or the service executor is disabled records a suspended plan without creating a CI watcher. Enabling the project does not resume that plan. Restore the executor and explicitly resume each selected plan after inspecting it. The project controls are trusted local host state, not permissions supplied by a PR or repository proposal. Existing private execution policy, role/command capabilities, CI override/no-CI permissions and revocation checks still apply.

## Durable flow

Migration 13 adds `review_automation` and `review_follow_ups`. Each project defaults to disabled revision zero. A plan records accepted handoff/follow-up IDs, exact PR/SHA/gate/instructions, dedicated worktree/root/checkout/branch, policy digest, project automation revision, plan revision, CI generation/ID and eventual review job ID.

1. Validate the accepted follow-up, current private policy and exact clean owned reviewer checkout. Persist the plan before scheduling anything.
2. For a waiting authorized plan, enroll its owned CI generation. Enrollment rechecks the plan/project switch inside the same SQLite transaction that accepts CI intent, closing the disable-during-enrollment race.
3. Let the shared CI observer wait without a worker. CI progress wakes the bounded follow-up dispatcher; it never selects another SHA.
4. When CI is ready, revalidate source/policy/checkout and obtain fresh bracketed PR/check evidence through review acceptance. A cached ready bit alone cannot accept the automatic job.
5. Atomically accept the existing service job/attempt/launch effect and link it to the plan as queued. Source-target compatibility, current project switch/revision, CI evidence, immutable binding and approved policy digest are checked inside that transaction.
6. The existing coordinator checks live workflow readiness, assignment, policy and capacity. Its claim transaction checks the project switch and plan again and atomically marks the plan dispatched with the worker claim.
7. Native runtime reservations and immediate launch/initial-input boundaries recheck automatic authorization. Initial assignment receipts retain their existing idempotency and uncertainty rules. Worker results, decisions, continuation, cancellation and cleanup remain the run operations.

The saved task uses `authorization: after-handoff`, a plan/follow-up reference and prompt version 4. Manual task authorization and version 1/2/3 prompt bytes remain unchanged. Reviewers keep the read-only role and return the same structured report contract; automation grants no permission to push, publish, edit project state or start another worker.

| Plan phase   | Meaning                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `waiting`    | Authorized to enroll/wait for its CI generation and seek review acceptance                     |
| `queued`     | Review job linked; current controls, freshness and capacity still gate its claim               |
| `suspended`  | Project/host/explicit control paused the plan; explicit resume is required                     |
| `blocked`    | Source, ownership, policy, CI or acceptance needs investigation; explicit resume is required   |
| `dispatched` | Capacity/launch intent claimed, not proof that a worker started or completed                   |
| `satisfied`  | A compatible existing review was reused; this plan does not own its worker                     |
| `cancelled`  | Automatic plan ended before dispatch; its retained job/resources remain separately inspectable |

Compatible existing manual reviews can satisfy a new automatic plan. They remain manual and are unaffected by automation disablement. Manual submissions do not implicitly reuse suspended automatic jobs; use a distinct manual request key and dedicated checkout. Existing same-target review and deliberate-repeat rules remain in force. Automation never creates an automatic repeat of an already terminal review.

## Disable, resume and races

Disabling a project increments its control revision and atomically suspends waiting/queued/blocked plans and their active owned CI waits. It does not touch manually enrolled CI requests or manual review jobs. Claiming an automatic job after this transaction is denied without reserving worker capacity. Enabling increments the project revision but leaves the suspended backlog untouched.

Starting a service without `--after-handoff-review` also suspends eligible waiting/queued plans before coordinator startup. Restoring the flag leaves those plans suspended. A new enqueue while the executor is absent is suspended too. This prevents a restart from silently replaying the backlog. Claimed/dispatched work remains governed by its saved attempt and run controls.

Explicit resume validates the original source, policy digest and owned checkout, binds the current enabled project revision, and creates a new owned CI generation. Any prior active owned CI request is suspended first. Results from old CI generations/revisions cannot make the resumed plan dispatch. The target SHA and accepted review job are never rewritten. A queued job can be reactivated only after the new generation passes; it must still pass fresh preflight before capacity claim and initial input.

Worker claims, CI intent acceptance and queue linking use transactional guards. There is no atomic transaction spanning SQLite and an external agent provider. An effect authorized immediately before disable can finish; runtime checks narrow that window but cannot retract a sent launch/input. If disable happens after a worker claim but before startup/input, the attempt can remain blocked or uncertain with retained resources. Do not reset that claim, start another worker or infer shutdown. Inspect/reconcile the run; running/claimed reviews require explicit run cancellation if they should stop. Already delivered reviews continue after automation is disabled, and explicit decision responses/continuations/interrupts retain their ordinary policy.

Plan controls reject dispatched/satisfied/cancelled plans. Cancelling a queued plan prevents automatic claim but does not silently cancel its service job, stop workers, delete checkouts or release ownership. Use explicit run/resource operations where necessary. Policy/context drift can require abandoning this automatic path and submitting a separately authorized manual review; resume never replaces the original binding.

## Recovery, observability and bounds

`follow_up_controlled`, `follow_up_queued` and `follow_up_dispatched` events accompany their mutations transactionally on the source implementation run. Queue acceptance and plan linking cannot acknowledge only half of the relationship. After uncertain local persistence, reopen and inspect the stable plan/review key before retrying. Existing claimed launches and inputs remain non-replayable.

One dispatcher handles bounded 32-plan pages, serializes wake-ups, and preserves wake requests received while scanning. It has no provider poll timer; newly enrolled CI waits wake the CI scheduler, and CI progress wakes the dispatcher. Failed one-plan source/gate checks block that plan without launching it. Unknown local writes or unavailable state stop the host for inspection. Up to 256 unresolved plans per project are accepted so project disablement remains a bounded transaction. Historical dispatched/satisfied/cancelled records remain retained.

Service shutdown drains the follow-up dispatcher, CI reader, transport and worker coordinator before closing state or releasing ownership. A ready CI record is historical, and exact source/readiness/policy/ownership/capacity are checked again before claim. No exactly-once external launch or provider snapshot is promised.

## Verification status

This implementation has static type, build, lint, formatting and module-boundary checks. Dedicated race/fault tests for #25/#26 and supervised live-provider verification have not been run. Existing migration fixtures are updated for schema 13, but have not been executed for this change. The preceding 327-test result belongs to #24's verification commit.
