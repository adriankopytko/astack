# ADR 0015: Targeted GitHub reads and journaled publication effects

- Status: accepted
- Date: 2026-10-19

## Context

Review delegation needs complete commit-bound check observations. Implementation handoffs and review publication need reusable provider primitives without automatic discovery, retry or tracker policy. A timed-out POST can succeed remotely, and a publication marker alone does not establish ownership or delivery.

## Decision

Introduce `GithubProvider` and `createGhProvider` with explicit host/repository/PR/full SHA targets. Reuse one bounded transport for REST JSON, controlled environment, complete process evidence, aggregate deadlines, capped explicit pagination and sanitized errors. The existing review reader delegates to this provider's paginated, bracketed check-run/status observation. Preserve skipped/cancelled/missing/ambiguous check evidence.

Consume publication through `publishGithubEffect`, using the existing immutable state effect intent/claim/resolution primitives. There is no new journal migration. A separately accepted host publication attempt names the exact commit; its `github-publication:v1` effect carries the schema-validated payload. Marker hashes bind payload and project/job/attempt/effect/key scope. A claim is persisted before the provider boundary, and only its first owner may send. Confirmed retry returns saved evidence; pending/unknown writes never replay by age.

Support creation of PRs for already published refs, append-only PR conversation comments and explicit summary reviews. Verify expected actor, remote refs or exact current PR head before POST. Send JSON through exclusive private files rather than argv. Query matching actor/body/target/marker and review action/commit evidence before confirming. Retain operational files privately for explicit host retention. Markers supplement remote evidence; they are not authentication or exactly-once provider keys.

An uncertain result is retained, never retried automatically. Explicit reconciliation requires host attestation that original controllers and children stopped and continued writer exclusion. It only queries remote evidence; absence remains unresolved. State write uncertainty remains distinct from remote execution uncertainty. Publication is not proof of current readiness, accepted implementation correctness, safe cleanup or permission to merge.

## Consequences

Existing review gains complete bounded check/status observation. Future handoff and findings operations can consume one provider contract and durable effect mechanism without embedding GitHub subprocesses in application policy. The library does not push Git refs, provide a publication CLI, install scanners/watchers, initiate automatic reviews, transition issues or enable write operations at service startup. Those operations need their own consumers and authorization. No ordinary implementation worker receives an authenticated publication inbox.

The first adapter requires host-selected credentials compatible with `/user`; it fails closed for unsupported authentication. GitHub cannot atomically compare a head and append a comment/create a PR, so races remain explicit. Retained remote edits, duplicate markers, changed targets, page/deadline limits and missing receipts block rather than authorize repairs. See [the operation contract](../github.md) for precise failure, retry and cancellation behavior.
