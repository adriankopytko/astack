# Targeted GitHub operations

## Implemented scope

`createGhProvider` supplies typed PR inspection/discovery, commit-bound checks, and PR/comment/review publication through an injected `ProcessRunner`. `publishGithubEffect` consumes an already accepted publication effect in the existing SQLite state journal. No new migration, background scanner, polling loop, GitHub Project requirement or automatic issue transition is introduced.

The existing `createGhReviewTargetReader` delegates to the same paginated check reader. Service review acceptance, dispatch and report validation therefore use this implementation without enabling publication.

These primitives are library APIs. The explicit [implementation handoff](handoff.md) now consumes PR publication with source-report validation, Git push and CLI finish/reconciliation commands. Automatic review dispatch, review-result publication and tracker transitions remain separate workflows. A returned review report does not itself authorize publication.

## Host configuration and authority

Construct a provider with:

```ts
const provider = createGhProvider({
  executable: '/trusted/bin/gh',
  runner: nodeProcessRunner,
  environment: hostSelectedEnvironment,
  now: Date.now,
  artifactParent: '/private/host-state/artifacts',
  timeoutMs: 30_000,
  maxPages: 20,
});
```

The executable and cwd must be absolute. The caller supplies a controlled environment, credentials and trusted existing artifact parent outside repositories; do not dump the environment or put credentials in requests, bodies, results or logs. Configured host GitHub credentials/settings are trusted. Construction/imports do not run commands or open state. Reads do not need `artifactParent`; writes require it.

Every operation explicitly names canonical lowercase host and owner/repository. PR operations require a PR number and full lowercase SHA-1/SHA-256 head. Discovery requires the source repository and head branch, scopes the query to that branch, includes closed PRs for reconciliation, and rejects unexpected attribution or duplicate identities. It never chooses the current-directory repository, discovers unrelated PRs or fetches Git objects.

Publication is a same-host orchestrator capability, not a restricted worker endpoint. The host must authorize the destination, expected actor, content and action before accepting intent. Keep publication jobs/attempts separate from worker-launch effects and bind the publication attempt to its intended commit. Project registration or a worker report does not grant GitHub write authority. This primitive does not itself implement higher-level accepted report policy; the implementation handoff consumer supplies that policy, while review-result publication remains separate.

## Reads and pagination

- `inspectPullRequest({target, root}, signal?)` verifies returned PR number, repository URL, base repository and full head SHA, returning normalized PR metadata rather than provider JSON or raw URLs.
- `discoverPullRequests({repository, sourceRepository, headBranch, root}, signal?)` enumerates the explicitly selected source branch in the base repository. Both source repository and branch must match every result.
- `readChecks({target, root}, signal?)` reads all bounded pages of check runs (`filter=latest`) and commit statuses at the full SHA. It verifies check-run head attribution, chooses the newest immutable status ID per context, rejects repeated IDs, and brackets checks with unchanged PR observations. Duplicate check names remain ambiguous and reject the review snapshot. The existing 64-check snapshot bound remains in force.
- `findPublication({publication, marker, root}, signal?)` inspects bounded PR/comment/review collections for one exact publication. Zero matches is an observation, not permission to repeat an uncertain write. Multiple matches, edited content, different author/action/SHA or conflicting metadata reject.

Pages use explicit `per_page=100&page=N` URLs, not provider-supplied next links or an unbounded `--paginate`. A full final allowed page remains incomplete until a shorter page proves exhaustion; reaching the cap rejects with `github_limit_exceeded`. Duplicate identities reject instead of silently dropping records. Concurrent collection edits can invalidate pagination; absence is never sufficient to authorize a write retry.

Successful checks map to pass; neutral/skipped map to skipping, cancellation to cancel, incomplete checks to pending and recognized failure conclusions to fail. Unknown output rejects. No observed checks remains empty and the review gate blocks it; missing checks do not imply success. This is not GitHub branch-protection evaluation or an atomic provider snapshot.

## Publication intent

`githubPublicationSchema` accepts three explicit payloads:

| Kind           | Required evidence                                                                                                                        | Effect                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pull-request` | Target base repository, expected actor, explicit source repository/head branch/full SHA, base branch/full SHA, title/body and draft flag | Create one PR for an already published branch       |
| `comment`      | Exact repository/PR/head SHA, expected actor and body                                                                                    | Append one PR conversation comment                  |
| `review`       | Exact repository/PR/head SHA, expected actor, body and `COMMENT` or `REQUEST_CHANGES`                                                    | Submit one summary review with explicit `commit_id` |

Automatic approval/merge, inline diff-position conversion, issue transitions, edits/deletes and pushing commits are not provided. No GitHub settings, branch protection or existing comments/reviews are modified. Bodies are bounded to 8,000 UTF-8 bytes and cannot contain the reserved `<!-- astack:` marker prefix.

Use the existing state operations to accept a host publication job and prepare its attempt/effect before calling the consuming operation. The prepared effect must have kind `github-publication:v1`, stable ID/key, the exact publication commit on its attempt and payload `{ publication }`:

```ts
const prepared = prepareStateAttempt(
  {
    schemaVersion: 1,
    attempt: publicationAttempt,
    effects: [
      {
        id: publicationEffectId,
        attemptId: publicationAttempt.id,
        kind: 'github-publication:v1',
        key: 'publish-result',
        createdAt: acceptedAt,
        payload: { publication },
      },
    ],
  },
  store,
);
// Proceed only after confirmed local persistence. Inspect uncertain local writes.
const result = await publishGithubEffect(
  {
    schemaVersion: 1,
    effectId: publicationEffectId,
    root: approvedCheckout,
    mode: 'publish',
  },
  { store, provider, nextId: () => `github-${randomUUID()}` },
  signal,
);
```

`publicationAttempt` belongs to a previously accepted host publication job; this example does not register projects, create jobs, infer ownership or approve policy. State acceptance/retry must preserve its original effect identity and payload. The existing metadata limit applies to the complete intent.

The operation derives a SHA-256 publication marker from the canonical schema-parsed payload, project/job/attempt/effect IDs and effect key. The marker discloses no local IDs, project names or paths. Its intent digest is not authentication or a GitHub idempotency key; matching actor/content/target evidence is still required. Bodies include the stable marker on a separate line.

Before POST, the adapter checks the authenticated `/user` login against the approved actor, queries matching publications, and verifies target evidence. PR creation verifies both remote head and base refs and refuses an unowned open same-source-branch PR. Comment/review publication requires the requested PR to remain open at the exact head. The selected credentials must support `/user`; unsupported installation-token authentication fails closed.

The private artifact helper creates a fresh owned mode-0700 directory and exclusive mode-0600 JSON request file. `gh api --input <file>` sends the exact multiline body; argv never contains it. Artifacts remain under the trusted parent for explicit host retention/recovery; this operation does not perform automatic retention cleanup. Do not point the parent into a checkout or commit these operational files.

At most one POST is attempted per provider call. The adapter then queries the appropriate collection and requires one exact author/content/marker/action/SHA match. PR creation also matches source/head/base/title/draft. A review's `commit_id` binds historical evidence to its reviewed SHA. A conversation comment cannot be atomically SHA-bound by GitHub; its marker records the intended SHA, not proof the head was unchanged at the instant of publication. Ref/head races and edited remote content fail conservatively. Confirmed publication is not current PR readiness or approval.

## Journal, errors, retry and cancellation

`publishGithubEffect` returns the existing `StateWriteResult<StateEffect>` contract:

| State/evidence                                 | Meaning and retry                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Rejected before claiming                       | No new publication authorized/executed                                                                                                          |
| `persisted`, effect `confirmed`                | Matching receipt durably saved; same-effect retry returns saved evidence without provider reads or writes                                       |
| `persisted`, effect `cancelled`                | Provider rejected before any POST attempt; error code saved, same effect is closed                                                              |
| `persisted`, effect `unknown`                  | POST may have occurred, provider threw, response was incomplete, receipt was absent/ambiguous, or reconciliation was inconclusive; never resend |
| Local `uncertain` or unresolved claimed effect | State commit may have happened; inspect exact effect identity before further action                                                             |

Only the first successful atomic claim may invoke the publishing provider. Saved/expired claims and unknown effects never become sendable by age, a different controller/key or an empty remote result. A preflight rejection closes that effect; correcting prerequisites requires deliberate new intent rather than automatic retry. A later workflow must reconcile old effects before accepting replacement publication for the same business result.

To inspect an uncertain effect, stop/exclude its original controllers and children first, then call:

```ts
await publishGithubEffect(
  { schemaVersion: 1, effectId, root, mode: 'reconcile', originalWriterStopped: true },
  dependencies,
);
```

The flag is a trusted host attestation, not process detection. It is required even when a claim expired. Reconciliation only calls `findPublication`; it never POSTs. Positive matching evidence confirms the original effect using its original claim token; absent/conflicting/incomplete evidence retains unknown. Keep competing host writers excluded while reconciling. Historical comment/review receipts can be recovered after the PR advances; this does not make them current readiness evidence. Edited PR metadata can leave PR-creation reconciliation unresolved.

All remote calls share an operation deadline (default 30 seconds, maximum five minutes), with each subprocess bounded to at most ten seconds and each output stream to one MiB. Complete root exit, absent original process group and complete untruncated stdout/stderr are required. These are process evidence, not domain success or proof escaped descendants stopped.

Reads return stable `github_auth_required`, `github_forbidden`, `github_not_found`, `github_rate_limited`, `github_timed_out`, `github_limit_exceeded`, `github_conflict`, `review_target_changed`, `github_failed` or invalid-output errors. Safe retry hints derive only from bounded numeric Retry-After/reset headers. The publication journal preserves available hints. Raw diagnostics, URLs, token values and environment are not returned. The legacy review-reader port retains its ordinary error envelope.

There are no automatic retries or sleeps, including on rate limits. The host decides when to repeat safe reads. A timeout, cancellation, nonzero status or malformed evidence after entering POST remains `github_write_uncertain`, even for an apparent rate/validation failure. Cancellation before the send boundary causes no POST; cancellation after it preserves uncertainty. Importing code or starting the ordinary local service never enables these write operations.

## Verification

The isolated GitHub tests cover paginated PR discovery, checks and publication lookup; page/deadline limits; rate-limit/auth/HTTP errors; malformed/incomplete subprocess evidence; exact actor/repository/PR/SHA and review-action attribution; and preservation of edited/ambiguous remote results. Valid HTTP JSON responses with LF/CRLF separators or no headers are accepted without relaxing JSON/domain validation.

Real disposable SQLite databases exercise confirmed retries after reopen, competing controllers through separate connections, expired/unattempted claims, interrupted provider effects, local claim/receipt commit uncertainty, immutable intent, cancellation, provider exceptions and mismatched receipts. Controller ID allocation failure rejects before claiming or calling a provider.

The subprocess tests execute a disposable fake GitHub CLI through `nodeProcessRunner`, using actual private request files and paths containing spaces. They simulate remote acceptance followed by a failed response, then recover matching evidence without a second POST. Fixtures are local and make no network requests, use no host credentials and do not touch real GitHub tracking or user-project resources. Live GitHub publication is not established by these tests.

## API references

Implementation follows the official [GitHub CLI API command](https://cli.github.com/manual/gh_api), [PR endpoints](https://docs.github.com/en/rest/pulls/pulls), [review endpoints](https://docs.github.com/en/rest/pulls/reviews), [issue-comment endpoints](https://docs.github.com/en/rest/issues/comments), [check-run endpoints](https://docs.github.com/en/rest/checks/runs), and [commit-status endpoints](https://docs.github.com/en/rest/commits/statuses). The adapter pins API version `2022-11-28`; unsupported server behavior rejects without falling back to human-readable output.
