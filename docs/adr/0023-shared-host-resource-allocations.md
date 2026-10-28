# ADR 0023: Share durable host resource claims across projects

Status: accepted

## Context

Existing retained-resource records support cleanup but do not allocate ports or names before concurrent project startup. A database claim cannot reserve an OS socket or authenticate a service owner. Failed startup and retained environments must not lose their resources by timeout.

## Decision

Use one shared private host database and a dedicated revisioned allocation registry, bound transactionally to accepted implementation job/attempt/project/repository/checkout/branch/SHA. Claim protocol/port conservatively across all addresses; names use explicit service/container/cache namespaces and stable owner-derived suffixes, with fixed-name serialization available. Insert existing cleanup holds and local events atomically with reservations.

Persist candidate claims before bounded exclusive-bind probes; perform no network IO inside SQLite transactions. Only pre-start known-busy candidates may advance through a host-specified list. Require a keyed, non-expiring startup receipt before any host effect. Returning an existing receipt never permits another startup. Verify observable endpoint binding plus independent host ownership/readiness attestation separately from reservation. Keep generic provider/service execution in later hooks.

Retained and uncertain environments keep their claims. Release only after exact revision/receipt targeting, truthful independent host shutdown/writer-exclusion attestations, and fresh free-port evidence where applicable. Release the registry and matching cleanup hold atomically. Guard active allocator holds against generic release via SQLite trigger. Never kill unrelated listeners or rewrite authored settings. Expose explicit library operations and offline CLI consumers, without startup scanners, background release or implicit execution authority.

## Consequences

Cooperating projects avoid conflicts within the shared database; unmanaged socket races remain possible and require conservative startup handling. Names require provider ownership evidence supplied by the host. Multiple state directories do not coordinate. Lifecycle hooks (#22) can consume this contract later. Worker shutdown and worktree removal remain separate, and blocked/retained allocator holds can prevent them until explicit verified release. See [the resource contract](../resources.md) for requests, evidence and recovery.
