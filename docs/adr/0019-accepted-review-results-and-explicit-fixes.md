# ADR 0019: Retain commit-bound review findings and publish explicitly

Status: accepted.

## Decision

Use accepted run reports as the sole durable source of review findings and artifact references. Do not duplicate untrusted proposals into a competing result store. Expose an explicit result view and separately persisted CAS freshness observations; stale or unavailable scope never rewrites the reviewed commit or establishes readiness.

Normal report acceptance remains strict. An explicit host historical-review flag can retain a reviewed proposal after a positively identified remote scope change, while preserving all local assignment/delivery/artifact and concurrency checks. Older report requests, evidence and prompt bytes stay unchanged when new optional fields are absent.

Publication is an offline host capability under coordinator exclusion, using a separate host job/attempt and the existing single-claim GitHub journal. Reserve the report binding and effect transactionally before any POST. Publish only fresh current scope, permit historical read-only receipt reconciliation, and never bypass unresolved writes with another key. Initially allow one publication intent per accepted report, without replacement or repeat-publication policy. Publication bodies are deterministic bounded selections of accepted findings; approval and merge remain unavailable.

A fix is a new explicit implementation with an immutable `fixOf` reference and a fresh owned checkout at the reviewed SHA. Validate source evidence inside queue acceptance and append its linkage event in that transaction. Ordinary task/report/publication/review operations handle the new cycle; no automatic remediation loop is introduced.

## Consequences

The orchestrator can retain useful findings when a PR moves without claiming current readiness. Publication, result acceptance, observations, worker liveness and cleanup remain distinct. Caller-selected finding indexes bound published content without truncating the stored report. CLI inspection provides a ready source reference; the host still supplies the concrete fix task.

The exact CLI composition exception `src/cli/review-results.ts` to `src/host/review-results.ts` holds offline coordinator ownership and wires trusted provider dependencies. Other CLI/host edges remain forbidden. No new live-service publication endpoint is installed. Known preflight publication failures require later explicit replacement policy rather than an improvised new key.
