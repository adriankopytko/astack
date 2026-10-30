# ADR 0025: Require executed verification for new implementation publication

Status: accepted

## Context

Initial handoff publication accepted explicit host attestations about checks. Lifecycle hooks now provide durable execution evidence. A worker report, zero exit alone or an unchecked passed flag cannot establish a fresh clean implementation handoff. Interrupted publication must retain its original no-replay guarantees.

## Decision

Define private per-role baseline, allowed lane/additional checks and explicit evidence age. Save approved plan/command digests in immutable job snapshots, omitting the field for legacy configuration. Run an explicit verification operation through named verify hooks, binding accepted report/input, owned checkout/full SHA, policy/command digests and artifact references. Persist aggregate intent/progress before effects; stop at failed/cancelled/unknown checks and never replay a run key. Recheck clean Git state, identity, artifacts and policy after all checks before recording passed evidence.

Require matching fresh executed evidence before any new handoff reservation and never-claimed push/PR stage. Repeat baseline completeness and actual hook evidence checks inside local claim transactions. Keep ordinary host publication authority separate from verification. Do not run checks implicitly during finish, service startup or reconciliation. Preserve legacy accepted records and already-claimed effect recovery as historical/inspect-only behavior, without reinterpreting attestations as new-write authority.

Keep per-check not-run/failed/cancelled/unknown evidence distinct, preserve worker reports, and record no output text/environment values. Explicit writer-excluded aggregate reconciliation can free an interrupted aggregate claim after hook writers are handled, but releases no service/hook/checkout resources. See [verification contracts](../verification.md).

## Consequences

Projects choose actual commands without framework-specific core logic. Missing/stale verification blocks new publication while preserving work and prior effects. Changing SHA, policy, artifacts or age requires a deliberate new verification intent; saved handoff references stay immutable and safe replacement constraints still apply. Existing accepted jobs without new verification approval require explicit new configured work rather than silent reapproval. Remote CI and actual sandbox/profile validation remain separate guarantees.
