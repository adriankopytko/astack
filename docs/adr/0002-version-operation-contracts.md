# ADR 0002: Version operation contracts and distinguish observations from durable work

Date: 2026-10-15

Status: Accepted

## Context

Library calls, CLI output, and future worker/service messages need the same semantics. A command returning successfully must not imply that a queued implementation or review has finished. Project selection must preserve local checkout identity without guessing from a repository name, remote, or service cwd.

## Decision

Version operation requests and result envelopes explicitly with `schemaVersion`. The first version is `1`. Use strict schemas at external/data-source boundaries, infer TypeScript types from those schemas, and reject unknown versions and fields. Keep package versions independent from contract versions.

Implement only contracts consumed now: package inspection and explicit project/checkout context resolution. Their results distinguish `completed` observations from `rejected` requests. A completed observation proves no resource ownership, registration change, Git inspection, or durable job acceptance.

Use opaque, separately branded project, checkout, and local repository IDs. A project records its selected primary checkout; another checkout requires an explicit checkout ID and matching project membership. Linked checkouts can share local repository identity; independent clones retain distinct local repository IDs regardless of remote URL. Paths are source facts, not identifiers or authorization.

Use stable error codes and bounded-purpose messages. Do not include raw request values, source exceptions, validation diagnostics, or credentials in public errors. Document retry and cancellation for each operation rather than putting a universal retry flag on every error.

The future durable submission contract will acknowledge accepted intent only after a transaction commits and include a stable job identity. It will not reuse a completed-read result to imply acceptance. Execution, publication, CI, review, and cleanup remain separate facts. Keep their design in [the operation contract document](../operation-contracts.md); add executable schemas as their operations are implemented.

## Consequences

`info --json` now emits a versioned result containing package information under `value`; its earlier unversioned scaffold shape is replaced. Human-readable output is unchanged. The library's `getApplicationInfo` now accepts a versioned request and returns the same result contract.

The context resolver requires an injected reader. Production registration, Git discovery, implicit cwd selection, saved-run binding, and context CLI wiring remain later delivery slices. This keeps the first contracts executable without inventing a registry, launching providers, or treating caller-supplied paths as verified ownership.

Unknown fields require deliberate contract evolution. Renaming fields, changing their meaning, or introducing incompatible result variants requires a new contract version. Stable codes are programmatic API; messages are for people. This introduces explicit migration work, accepted in return for predictable agent behavior.
