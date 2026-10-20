# Explicit manual review delegation

## Implemented scope

An orchestrator requests a review for an explicit registered project, base repository host/name, PR number and full head SHA. No implementation job or claim is required. Automatic initiation is absent. The reviewer uses its own existing Astack-owned checkout, branch, role configuration, durable job and attempt. Static review starts no services. Requested integration resources remain durable blockers until isolated provisioning is implemented.

Worktree preparation stays explicit. The requested commit must already exist locally; this workflow never fetches, checks out remote refs, creates a worktree implicitly, discovers unrelated PRs, edits fixes, publishes GitHub reviews/comments, pushes or merges. Fork PRs are supported through their base repository/PR and verified head SHA, with source repository attribution recorded separately. Obtaining an external commit locally is a separate authorized operation.

## CLI

Prepare a fresh owned checkout at the selected full PR head SHA and configure the reviewer role and project Herdr target. Configure an approved Codex reviewer command with `--sandbox read-only` and the existing required native arguments. Start `service run --codex-herdr` explicitly. Then, from any directory:

```sh
astack review submit \
  --project project-a --checkout reviewer-checkout \
  --key review-request-42 --branch review-42 --commit <full-pr-head-sha> \
  --host github.com --repo example/project --pr 42 \
  --check test --check lint --json

astack review inspect <job-id> --json
astack service wake --json
```

Host and repository names are normalized to lowercase by the CLI; library callers supply canonical lowercase values. `--instruction` replaces the default scoped Markdown list (`AGENTS.md`, `AGENTS.override.md`). Instructions are digested, never copied into state. Submission requires a live service; inspection reads saved state offline and does not query GitHub or workers.

The local host resolves a trusted absolute `gh` executable from host PATH; library hosts can inject `githubExecutable` or a `ReviewTargetReader`. Only an explicit credential/configuration environment allowlist is passed to gh. Tokens remain in process environment, never argv, state, prompts or diagnostics. No raw provider output is retained or returned.

## Acceptance and duplicate requests

`submitReview(input, dependencies, signal?)` validates the explicit target, clean owned checkout, instruction references, bracketed provider evidence and approved configuration. It records manual-request authorization, initial gate policy/snapshot, immutable configuration, job, attempt and pending launch before dispatch. A stale target or unverifiable provider read rejects acceptance without a launch. A verified target with pending/failing checks can be accepted and remain blocked in the queue.

SQLite migration 7 adds request aliases and a target lookup index. Within one immediate transaction, a new request for the same project/repository/PR/full SHA reuses the existing review. An alias preserves the new request key and normalized submission so retries return the same receipt even offline or after policy changes. The returned assignment identifies the original checkout; the newly proposed checkout remains unused. Different gates, resources, instruction paths or configuration patches conflict instead of silently changing a saved review.

`--repeat` with a new key and fresh dedicated checkout creates a new job and attempt for deliberate repeat review, subject to ordinary capacity. Reusing its key returns that same attempt. Run report acceptance now establishes terminal review outcomes. Active/needs_decision/cancel_requested reviews remain unresolved; a new key targeting a terminal review requires an explicit repeat and a fresh checkout. Neither waiting for a report nor UI done proves a finished review. The same original request key still returns its saved terminal receipt.

A reviewer checkout cannot be shared with implementation/generic jobs, or another distinct review attempt, even after quiescence. The transaction enforces this in both directions. An existing implementation checkout can never be borrowed for review merely because it appears idle.

## Gates and provider evidence

The GitHub adapter uses explicitly targeted `gh api` reads through the shared provider. It brackets paginated check runs and commit statuses at the full requested SHA with unchanged PR observations, verifying repository, PR number, head and base SHA. The worker uses the saved base SHA for diff scope; missing local base/merge-base objects remain blockers. Checks normalize to pass/fail/pending/skipping/cancel; neutral/skipped and cancelled checks do not pass. Up to 64 uniquely named checks are supported. Duplicate IDs/names, page/deadline limits, oversized/truncated output, malformed JSON and uncertain process evidence fail closed. See [GitHub operations](github.md) for transport, pagination, error and retry contracts. This review workflow does not enable the separate publication library operations.

This is a bracketed observation, not an atomic GitHub snapshot. It cannot detect an ABA head change or prevent changes immediately after inspection. Freshness is checked before capacity claim, again immediately before first input, and on observations after acknowledged delivery. A moving head never replaces the saved SHA; a changed base SHA also blocks the saved diff scope. Post-delivery staleness becomes `needs_decision` for an observed worker, while an uncertain worker remains `unknown` with separate `reviewFreshness` evidence; it does not silently cancel an existing worker or authorize another launch. Live quiescence/termination and report authentication remain separate work.

Without `--check`, every observed check must pass and at least one check must exist. With selected names, each must exist and pass; other checks remain visible in evidence. Missing, skipped and cancelled checks never count as success. This is an explicit Astack check policy, not an assertion that GitHub branch protection or rulesets were fully evaluated. Draft, closed and merged PRs block dispatch.

To review before checks pass, the host policy must contain:

```json
{ "execution": { "review": { "allowGateOverride": true } } }
```

This is a fragment of the existing private host policy, not a complete configuration. Submit with `--override-gate 'Reason to review while CI is pending'`. The command is the manual authorization; the host setting permits its CI override. Repository proposals cannot grant permission. The override is recorded in the task and report proposal, preserves pending/failing/missing checks, and cannot bypass a changed target, unsafe checkout, draft/closed PR, unavailable provider, revoked configuration, capacity or integration-resource blocker. The optional host field has no default materialization, preserving existing policy digests when absent.

No background PR scanner, cron, check watch or automatic review hook is installed. Explicit submissions, service startup, provider notifications and `service wake` drive reconciliation. Checks becoming green alone do not wake this version; event subscriptions or targeted check watching belong to later work.

## Delivery, results and retry

Implementation and review share the durable initial-input delivery mechanism. The review input key is `review:initial:v1`; reconstruction uses only saved task bytes. Acknowledged inputs never resend. Pending or uncertain input remains unknown for inspection, never a reason to launch another worker. Restart can make the first authorized delivery after proving receipt absence and rechecking ownership, instructions, approved policy and target gates.

The prompt carries the acceptance-time check snapshot, explicitly labeled as historical. Fresh observations after delivery are saved under `entry.observation.evidence.reviewGate`. `entry.readiness` preserves a preflight rejection, while the generic queue reason remains `workflow_blocked`. An overridden review still records failing/pending CI; no check is rewritten as passed.

`reviewWorkerReportSchema` defines an untrusted proposal bound to job, attempt, checkout and exact target: reviewed/needs_decision/failed, bounded findings, blockers, gate policy, acceptance snapshot and optional freshly verified snapshot. Parsing a proposal is not authentication or accepted completion. The review workflow never consumes terminal transcripts; `acceptedOutcome` stays null until separate host report acceptance validates a terminal result. Reports, decisions, explicit continuation, cancellation and events are implemented through separate run operations; resource cleanup remains separate.

Cancellation before acceptance writes nothing; after acceptance, caller disconnection does not retract intent. During a possible provider effect, preserve pending/unknown state and inspect the saved attempt. Runtime Escape remains an input primitive, not cancellation or teardown proof. GitHub reads can be repeated safely; uncertain native launches/input cannot.

## Verification

Disposable repositories, owned worktrees, SQLite state, private sockets and injected providers cover external fork attribution, manual acceptance, aliases/repeats, dedicated-checkout conflicts in both directions, capacity, pending CI, overrides, stale heads, integration blockers, report proposals, offline inspection, restart and lost input. GitHub wrapper fixtures cover exact argv/cwd/environment, pending check state, identity changes, malformed checks and incomplete output. No real agents, live PR writes or user project resources are exercised by default verification.

See [run operations](runs.md) for report validation and accepted outcomes, explicit response/resume/cancellation, event waiting and retained resources.
