# ADR 0013: Explicit host authorization for proven input refusals

- Status: accepted
- Date: 2026-10-18

## Context

A live supervised pilot exposed unsupported Herdr prompt argv. The CLI rejected the extra separator before connecting, but the runtime retained a pending action because its generic provider result did not establish non-delivery. A parser reproduction or idle screen alone must not automatically settle historical uncertainty. Default fixtures had asserted the unsupported argv without exercising the installed CLI parser.

## Decision

Use the installed protocol 22 syntax `herdr agent prompt <unique-name> <text>` with literal argument arrays. Share argument construction with an explicit offline CLI compatibility probe against a private nonexistent socket; keep that probe out of default verification and package execution.

Provide `runtime authorize-input-retry` as a trusted host recovery operation, not a worker/report endpoint. Require exact attempt, input key, digest and generation, plus explicit host attestations of independent proof of non-delivery and stopped original callers/descendants with no possible late write. The CLI holds the coordinator lock for the operation. Library hosts must supply equivalent exclusion and coordinate other runtime controllers.

Recheck the active assignment, enabled accepted policy, owned worker identity and ready input surface. In one transaction, preserve an immutable host-attestation record for the selected pending input and remove its active receipt. No input is sent. A future explicit input call or coordinator pass can deliver the same accepted bytes using the same key. Persist the new action before sending, with a strictly newer generation. Refuse changed bytes/kind under a recovered key.

Repeated authorization of the same generation returns its saved record and never clears a newer action. Acknowledgements compare the complete action including generation, preventing a delayed acknowledgement from settling another send. SQLite migration 9 adds the authorization journal; older actions decode as generation zero without rewriting their history.

## Consequences

Known refusals can be recovered deliberately while timeouts, missing receipts and genuinely uncertain sends remain blocked by default. This is a host attestation, not provider-certified proof: the tool cannot verify the truth of the flags. The operator must establish non-delivery independently; idleness, age, PID absence or a reproduced bug alone are insufficient. An incorrect attestation can cause duplicate execution, so it must never be generated automatically from a generic failure or an untrusted worker proposal.

The operation does not retry launches/interrupts, release worker capacity, authorize replacement agents, stop processes or clean resources. Cancellation, stale assignment and revoked policy prevent fresh authorization. Live verification must record the basis for host recovery separately from provider receipts and must not claim exactly-once execution.
