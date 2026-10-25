# Accepted review findings and explicit follow-up

Issue #27 adds operations over the existing durable accepted run reports. Findings and artifact references are saved by ordinary `run report` acceptance before acknowledgment (requests up to 48,000 UTF-8 bytes, accepted envelopes including verified evidence up to 96 KiB); there is no second report store or transcript scanner. Only an accepted `reviewed` report with matching job, attempt, project, dedicated checkout, gate, acceptance snapshot and full reviewed SHA qualifies. Duplicate report keys retain their existing immutable semantics.

## Historical results and observations

Normal report acceptance still requires unchanged remote head/base. If the PR moves while a reviewer works, the host can explicitly use `run report --accept-historical-review` to retain its findings as historical evidence. This option applies only to `reviewed` proposals. It does not bypass assignment, acknowledged input, clean local checkout, exact local SHA, artifact validation, cancellation or report CAS. A positively identified scope change can be retained; authentication failures, timeouts and other unavailable provider evidence cannot be interpreted as a changed head. The original proposal is never rewritten. `evidence.historicalReview: true` distinguishes historical acceptance from current scope evidence.

`review result inspect <job-id> --report-key <key> --json` reads an accepted report, assignment, last observation and a fix reference offline. Freshness is `not_checked`, `current`, `stale` or `unavailable`. An explicitly historical report starts stale even before a separate observation. Saved observations are historical snapshots, never current authorization.

With the coordinator stopped, `review result observe --job <id> --report-key <key> --json` rechecks the owned checkout identity and exact GitHub PR scope. A changed head/base, closed PR or draft is stale; unavailable evidence stays unavailable. Migration 14 stores observations separately from immutable findings, with revision CAS and transactional source-run events. A late observation cannot overwrite a newer revision. There is no scanner, poll timer or implicit provider read on inspect.

## Explicit GitHub publication

The host reviews the content and selects the exact accepted report before publishing. A trusted request file contains:

```json
{
  "schemaVersion": 1,
  "jobId": "review-job",
  "reportKey": "review-report",
  "reportId": "report-digest",
  "key": "publish-review",
  "actor": "approved-login",
  "kind": "review",
  "event": "REQUEST_CHANGES",
  "findingIndexes": [0, 2]
}
```

Finding indexes are zero-based. Omit the array to include every finding, or provide an empty array for a summary without findings. `COMMENT` is the default event; approval and merge are unsupported. `kind: comment` allows a conversation comment with event `COMMENT`. The deterministic body includes the full reviewed commit, summary, selected findings, selection count and blockers. It contains no local run IDs, checkout paths, instruction contents or provider handles. Report text is requester/worker data: the host must check it for sensitive content before publication. The complete report remains local even if only selected findings are published. Invalid indexes, reserved marker content and bodies over the existing 8,000-byte provider limit reject before provider reads or publication intent; nothing is silently truncated.

```sh
astack review result publish --file /private/path/publication.json --writers-stopped --json
astack review result publication <job-id> --report-key <key> --key publish-review --json
astack review result reconcile --job <id> --report-key <key> --key publish-review --writers-stopped --json
```

These host commands require the coordinator stopped; they acquire kernel-backed coordinator ownership before opening/migrating state. `--writers-stopped` attests original controllers and descendants are stopped and remain excluded. It is not an automatic liveness check. Imports, service startup, result acceptance and observation never enable publication.

New publication requires a fresh unchanged open non-draft PR/head/base. Migration 14 atomically reserves an immutable report-bound record, a separate host job/attempt and one existing `github-publication:v1` effect before any POST. The ordinary publication journal verifies actor, target, body and stable marker and claims before sending. At most one publication intent is accepted per report; another request key cannot bypass a claimed/unknown or already published effect. The first version has no replacement/repeat-publication command, including after a known preflight rejection. Preserve the original evidence rather than inventing another send key.

Confirmed retries are saved historical reads without provider/checkout access. Claimed/unknown writes never resend, including after restart or claim expiry. Explicit reconciliation is read-only and can recover matching historical receipts after the head moves; absent/edited/ambiguous evidence stays unresolved. Publication status remains separate from report acceptance and current readiness. GitHub reviews use `commit_id`; conversation comments cannot atomically bind the head at send time. Follow the [GitHub contract](github.md) for exact matching, private JSON request files, limits, cancellation and uncertainty.

## Explicit fix delegation

`review result inspect --json` returns `fixReference` with the accepted review job/attempt/report/key, digest and commit. Add a nonempty unique `findingIndexes` array and save that object in a trusted JSON file. Then prepare a fresh owned implementation checkout at that exact reviewed commit and request a separate implementation:

```sh
astack implement submit --project project-a --checkout fix-checkout \
  --key fix-review-1 --branch fix-review-1 --commit <reviewed-full-sha> \
  --task 'Address finding 0: describe the concrete requested change here.' \
  --fix-of /private/path/fix-reference.json --json
```

The service validates the accepted source and reference digest. A queue transaction rechecks source project/repository/attempt/report/SHA, finding indexes and that the fix checkout has no prior job. Acceptance and the `review_fix_accepted` source-run event are atomic. The saved implementation submission carries `fixOf`; its prompt adds the explicit reference. Ordinary implementation prompts with no reference retain identical bytes. The host supplies concrete task details; a reference alone does not silently copy arbitrary review content into a task.

This starts a new implementation job, input key, report, publication and SHA-bound review cycle. It never resumes the reviewer as an implementer, reuses its checkout, changes the reviewed SHA, automatically edits fixes, pushes or merges. Historical findings remain linked to their original commit, even after a fix is accepted. Reusing the same implementation key returns its saved receipt; a different request or reused checkout conflicts.

## Verification

Disposable Git repositories/worktrees and SQLite state exercise duplicate report acceptance, exact source/SHA validation, historical acceptance, stale/unavailable observations, late-observation CAS, publication limits, concurrent controllers, restart, lost publication responses, exact historical receipt recovery, immutable request keys, rollback of intent/job/event acceptance, and linked fixes in fresh checkouts. Existing provider fixtures exercise marker/actor/body/SHA attribution and interrupted writes. Default tests use fake providers and launch no real user agents or GitHub writes. Live-provider compatibility remains a separate supervised check.

Verification on 2026-10-25: `pnpm check` passed 366 tests with zero failures, plus build, types, typed lint, formatting and resolved module boundaries. The large-findings regression also passed independently after moving pure publication validation ahead of provider reads. Compiled CLI tests verified neutral-directory offline inspection and coordinator exclusion before provider access. The first full run exposed the ordinary row-reader cap on otherwise valid large reports; the dedicated accepted-report reader and total envelope bound fixed it before the final passing run. No live-provider result is implied.
