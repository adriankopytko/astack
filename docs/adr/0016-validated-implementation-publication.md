# ADR 0016: Explicit validated implementation publication

- Status: accepted
- Date: 2026-10-23

## Context

A completed implementation report establishes a validated local outcome. It does not authorize pushing Git refs, creating a PR, requesting review or releasing worker resources. The GitHub effect primitive needs a consumer that binds publication to the original assignment and survives interruption between Git and GitHub writes.

## Decision

Introduce explicit host-only finish/inspect/reconcile operations and CLI commands. Validate the accepted implementation report, acknowledged original assignment digest, registered retained owned checkout, exact clean completed commit and fresh accepted artifact evidence. Require named host verification attestations and explicit publication contents/actor/destination. Hold coordinator ownership for the offline CLI operation; callers attest and enforce original writer/descendant quiescence separately.

Migration 11 adds immutable keyed handoff intents and one current handoff per source implementation job. Atomically reserve a separate host publication job/attempt with Git push and GitHub PR effects. Persist each claim before the effect boundary. Push an explicit HTTPS destination with exact SHA/refspec, expected-head lease and verified fast-forward ancestry; no named remote or worker-authored hook is executed. Reuse the existing marked GitHub publication primitive.

Revalidate source and exact remote evidence before final acceptance. Atomically save acceptance, PR receipt, optional explicitly authorized review request and run event. The requested review is not a queued review job. Later dispatch must still create/select its dedicated owned checkout, validate host policy/capacity and gate on fresh exact PR/SHA/check evidence.

Saved accepted retries return historical evidence. Previously claimed effects only reconcile; no elapsed time, empty query or replacement key authorizes replay. Read-only reconciliation cannot start even an unclaimed stage. Deliberate replacement requires the exact prior prepared handoff ID, no uncertain push and no claimed/unknown/confirmed PR; seal unused predecessor effects and retain abandoned intent atomically.

The composition root lives at `src/host/handoff.ts`. Permit only `src/cli/handoff.ts` to import this host entrypoint; preserve exact existing service/run host-entry exceptions. Core/application remain independent of adapters and CLI objects. No service RPC endpoint, import-time effects, recurring polling or automatic review is added.

## Consequences

One orchestrator can explicitly publish a validated implementation and durably authorize a later review without making a worker responsible for GitHub writes or reviewer launch. GitHub and Git remain separate nontransactional systems: interruption can retain unknown state, and a PR or branch can change after acceptance. Explicit conservative replacement recovers known preflight failures without laundering uncertain sends.

Verification attestations are trusted host statements, not a project hook runner. Worker shutdown, resource release and checkout cleanup remain independent. Git publication initially supports controlled HTTPS/gh credentials and rejects custom transport configuration. See [the complete contract](../handoff.md) for authorization, evidence, retry, cancellation and limits.
