# Validated implementation publication

## Implemented scope

`finishImplementation`, `reconcileImplementationHandoff` and `inspectImplementationHandoff` consume completed implementation runs and the Git/GitHub publication primitives. The CLI exposes these through `handoff finish`, `reconcile`, `inspect` and `follow-ups`. Migration 11 adds a durable handoff record; acceptance and any explicitly authorized follow-up review request are committed together.

This is an explicit trusted host operation. It does not launch reviewers, watch CI, merge PRs, change issues, shut workers down, release capacity or delete resources. Saved review requests are inputs for the separately opted-in [follow-up dispatcher](automatic-review.md), not accepted review jobs. Attach a dedicated owned checkout explicitly before dispatch. Manual `review submit` remains available with its own owned checkout, policy, capacity and fresh target/check gates.

## Host authority and preconditions

Before publication, the host must:

1. Accept a completed implementation report through normal run validation. A worker proposal or UI idle status is insufficient.
2. Run explicit [executed verification](verification.md) against the accepted completed report and select its passed record. New push/PR stages require the exact approved baseline/lane checks, unchanged source/artifacts/policy and unexpired hook evidence. Legacy attestations remain historical data, not new-write authority.
3. Stop all original writers and descendants, keep them excluded, and stop the local coordinator. The CLI takes the same kernel ownership lock before writable state/migrations. `--writers-stopped` records the host's attestation; it neither kills workers nor detects their quiescence. Independent library callers must enforce equivalent exclusion across the whole operation, including reconciliation.
4. Explicitly approve the destination host/source/base repositories, branches, full SHAs, expected authenticated actor, PR contents and optional review request. Neither repository configuration nor a worker report grants this write authority.

The source must still be the registered, ready, retained owned implementation checkout, on its saved branch, clean at the completed report's exact commit. Original deterministic assignment delivery must be acknowledged with the saved matching input digest. Project/repository/checkout/attempt/worktree IDs and report evidence must agree. Fresh source observations bracket artifact validation and precede each new stage and final acceptance. Trusted writers must remain excluded; these repeated reads are not filesystem or GitHub transactions.

## CLI

All commands honor the global `--state-directory`. Reads require existing migrated state. Finish/reconcile require exclusive coordinator ownership and can migrate existing state; imports and ordinary service startup do not enable publication.

```sh
astack handoff finish --file /private/host/handoff.json --writers-stopped --json
astack handoff inspect <implementation-job-id> --key publish-v1 --json
astack handoff reconcile <implementation-job-id> --key publish-v1 --writers-stopped --json
astack handoff follow-ups --project <project-id> --limit 20 --json
```

Finish/reconcile accept `--git-executable /trusted/bin/git` and `--github-executable /trusted/bin/gh`. Otherwise the host executable resolver selects installed trusted binaries. The request file must be a stable, regular, single-link UTF-8 JSON file of at most 16,000 bytes. Do not put credentials in it or commit operational request files.

Example request (replace placeholders and SHAs with actual accepted evidence):

```json
{
  "schemaVersion": 1,
  "jobId": "implementation-job-id",
  "reportId": "accepted-report-id",
  "key": "publish-v1",
  "publication": {
    "schemaVersion": 1,
    "kind": "pull-request",
    "target": { "host": "github.com", "repository": "example/toolkit" },
    "actor": "expected-login",
    "sourceRepository": "example/toolkit",
    "headBranch": "task/example",
    "headSha": "1111111111111111111111111111111111111111",
    "baseBranch": "main",
    "baseSha": "2222222222222222222222222222222222222222",
    "title": "Implement the requested change",
    "body": "Summary and inspected verification results.",
    "draft": false
  },
  "expectedRemoteHead": null,
  "verification": {
    "source": "executed",
    "id": "verification-example"
  },
  "review": {
    "gate": { "requiredChecks": ["ci"], "overrideReason": null },
    "instructionPaths": ["AGENTS.md"]
  },
  "replaces": null
}
```

Set `review: null` (also the default) to disable a follow-up request. The head branch must equal the assigned task branch without `refs/heads/`; `headSha` must equal the accepted completed commit. `baseSha` is an explicit current destination base, not necessarily the original assignment base. Fork source repositories must be explicitly approved and use the same GitHub host. `expectedRemoteHead: null` means create an absent branch; an existing branch can advance only from the supplied full SHA, with verified local fast-forward ancestry. An already identical remote head is observed without a push and grants no branch ownership.

Executed verification supports up to eight selected checks; the handoff references its exact record. Up to eight unique instruction paths are accepted. A conservative handoff-record budget reserves room for the eventual receipt and duplicated review authorization before any remote write. Invalid or oversized requests reject locally.

## Durable stages and outcomes

Preparation atomically saves the immutable request, original source binding, a separate host publication job/attempt and two pending effects: `git-push:v1` and `github-publication:v1`. It never adds another worker attempt to the implementation job. One current handoff is allowed per implementation job; a key cannot be reused for changed content.

1. Claim the Git effect durably, inspect the explicit remote branch, and perform at most one exact SHA-to-ref push when necessary.
2. Require fresh matching remote head evidence and an unchanged source before executing the PR publication effect. The GitHub primitive verifies actor, head/base refs and conflicting PRs before sending, then finds the exact marked publication.
3. Reinspect PR repository/number/full SHA, source/head/base branches and base SHA, open state, actor/title/body/draft and marker, plus the exact remote branch and local source.
4. Atomically mark the handoff `accepted`, save the receipt and any requested review target/gate/instructions, and append `handoff_accepted` to run events.

CI readiness is checked later when a review is accepted/dispatched; publication can accept a draft PR or a PR with pending checks. A historical accepted handoff is not current PR readiness. Successful retries return its saved evidence without querying providers or requiring the original checkout to remain present.

| Evidence                            | Interpretation                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `persisted`, record `accepted`      | Exact publication was observed and acceptance plus optional follow-up request committed                  |
| `persisted`, record `prepared`      | Intent exists; inspect both effect states and sanitized evidence, not just the outer persistence outcome |
| Effect `cancelled`                  | Provider rejected before sending that effect; it is permanently closed                                   |
| Claimed/pending or `unknown` effect | Write may have occurred; inspect the original effect, never resend it                                    |
| Local `uncertain`                   | Commit may have happened; reopen and inspect the same key before proceeding                              |
| `abandoned`                         | Explicitly superseded safe intent retained for audit; it cannot resume                                   |

The CLI returns a nonzero exit for prepared/abandoned/error outcomes. Inspecting an absent handoff returns null. Read-only `follow-ups` pages use handoff IDs as `--after` cursors; `nextCursor` is the handoff ID, not a follow-up ID. This is a browsable listing, not a durable arrival cursor: new records can sort before an earlier cursor. Use monotonic `run events` and its explicit consumer acknowledgements to process arrivals without scanning GitHub. Reading a follow-up never dispatches or consumes it.

## Retry, interruption and cancellation

Repeating `finish` with the same request can start a never-claimed next stage. For any previously claimed stage it only observes and reconciles positive evidence; expiry, absent remote evidence or a new controller never permits resending. `reconcile` performs no remote writes, including when a later stage has never been claimed. It can save matching observations or final acceptance. Stop/exclude original effect writers and their children before either operation.

If a process crashes after the push or PR POST but before saving the receipt, inspect/reconcile the same key. Only exact matching branch/PR evidence can confirm the effect. An absent/changed/edited/ambiguous result stays unresolved. A failed PR stage does not undo a confirmed push, and no rollback deletes remote refs or PRs.

A known preflight rejection can be corrected through deliberate replacement: use a new key and set `replaces` to the current prepared handoff ID. Replacement is atomic and only allowed when no push is unknown or pending with a claim, and the PR effect is cancelled or never claimed. It seals all never-claimed predecessor stages as cancelled and retains an abandoned record. A confirmed push may remain and be observed by the replacement. Accepted, confirmed-PR or uncertain-publication records cannot be superseded this way; a new key cannot bypass uncertainty. A changed completed commit requires a new implementation assignment, not replacement of the old report.

Application operations accept `AbortSignal`. Cancellation before a send causes no new remote write; once execution enters a write boundary, timeout/cancellation/error is conservatively uncertain. Source revalidation checks cancellation before acceptance. The CLI does not install a separate signal/worker cleanup manager: process termination can leave a saved claim requiring reconciliation. A long operation or expired lease does not prove its subprocesses stopped.

## Git execution and resource limits

The Git adapter constructs an explicit canonical HTTPS repository URL, never a named remote. It passes explicit argv/cwd/environment, disables global/system config, hooks, fsmonitor, prompts, replacement objects, graft files and lazy fetch, allows only HTTPS, and supplies a fixed, quoted approved `gh auth git-credential` helper without modifying Git configuration. It rejects local includes, URL rewrites, credential/HTTP/protocol/push/sendpack/signing and selected command-bearing core configuration. Custom credential helpers, SSH-only setups and enterprise transport overrides are not supported by this path. Config rejection never prints values.

For an existing branch, `merge-base --is-ancestor` must succeed locally before push. The push uses an exact SHA refspec, explicit expected-head lease, no hooks, tags or recursive submodules. The lease guards remote movement between observation and update; no history rewrite is authorized. See Git's [explicit lease semantics](https://git-scm.com/docs/git-push) and [credential helper protocol](https://git-scm.com/docs/gitcredentials).

Each Git subprocess has a 30-second deadline and 128 KiB capture bound per stream. Complete exit evidence, absent original group and complete untruncated output are required. The GitHub provider retains its separate aggregate deadlines, bounded reads and private request artifacts under the trusted state root. No raw process diagnostics, credential values or arbitrary environment dumps are journaled. Artifact retention remains explicit host work.

This is trusted host execution, not a sandbox against malicious executable installations, host configuration, Git objects or concurrent privileged filesystem changes. Captured process-group absence does not prove escaped descendants stopped. Neither push nor observation reserves a remote branch against future human edits. Worker shutdown, safe worktree removal and capacity/resource release retain their independent contracts and can fail without changing accepted publication.

## Verification

`tests/handoff.test.ts` uses disposable registered Git repositories and owned worktrees, real SQLite state, and an injected implementation runtime. It accepts a completed report through the ordinary run contract before exercising publication. No real user worker or GitHub write is involved.

The scenarios cover clean exact-commit acceptance, optional review authorization, durable retries after reopening state, competing controllers, original input/ownership/report/branch/SHA mismatches, changed artifact bytes, and missing writer attestations. Lost push and PR responses reconcile without repeating writes; absent evidence stays unknown, including after claim expiry. Never-claimed later stages remain untouched during read-only reconciliation. Explicit predecessor replacement recovers known preflight rejection while preserving abandoned records, and cannot bypass uncertain effects.

Fault injection covers controller loss after claim persistence, lost local push/PR receipt acknowledgements and lost final acceptance acknowledgement. A SQLite trigger rejects the acceptance event to establish that acceptance and the review request roll back together, while already confirmed remote effects remain available for later read-only recovery. Accepted publication preserves run outcome, original worker attempt and retained cleanup resources. The compiled inspection CLI reads saved evidence from outside the repository; offline host execution rejects coordinator ownership conflicts before provider effects. Upgrade coverage includes pre-event-journal databases and a version-10 database with an already completed implementation: migration 11 preserves accepted reports and retained resources without launching workers.

`tests/git-publication.test.ts` checks explicit destination/refspec/lease, fast-forward evidence, matching-ref observation without push, controlled credentials/environment, forbidden local configuration, malformed/wrong/incomplete remote evidence and uncertainty after the send boundary. A disposable executable at a path containing spaces exercises the real subprocess boundary: it records a ref update, exits unsuccessfully, and a fresh adapter recovers the matching observation without a second push.

The full `pnpm check` command includes these suites alongside formatting, typed lint, TypeScript, resolved dependency boundaries, build and existing isolated tests. These fixtures establish controlled recovery behavior; they do not verify live GitHub transport, real credentials, hosted PR races or real-agent shutdown. A live disposable publication pilot still requires explicit opt-in. New publication now requires [executed verification](verification.md), using migration 18 and immutable approved plan digests in the accepted job snapshot. Already accepted historical handoffs and claimed effect reconciliation do not rerun checks.

## Host publication attempt completion

Successful handoff acceptance records a separate terminal `completed` result for its host publication attempt in the same transaction as handoff acceptance and its events. Both exact expected effects must be confirmed, their receipts must match the saved intent, and project/repository/checkout/branch/SHA/source-report bindings must agree. This resolves the host attempt without completing a worker, releasing worker resources or removing its checkout.

With coordinator exclusion and stopped original writers, repeating `handoff finish` or `handoff reconcile` also settles a missing terminal host result for an already accepted historical handoff. It uses saved confirmed evidence only: no provider access, push, POST, artifact read or live checkout is required. A `publication_finalized` source-run event is appended only when the terminal result is first created. Repeated settlement preserves result identity/time and adds no event. Inspection, startup and migrations remain read-only with respect to this recovery; pending/unknown effects do not qualify. Uncertain local completion must be reopened/inspected and retried through the same explicit command, never a new send key.

Verification is checked before every never-claimed external stage, including when a prior push is confirmed. Stale evidence blocks a new PR without replaying the push. SQLite effect-claim checks validate the approved baseline and actual hook records as well. Finish/reconciliation never runs verification implicitly; use the separate explicit operation and existing safe replacement rules for a deliberately new proof.
