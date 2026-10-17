# ADR 0005: Resolve host-approved configuration and snapshot it with jobs

- Status: accepted
- Date: 2026-10-17

## Context

Projects need different roles, tools, verification hooks and skill versions while sharing orchestration mechanisms. Worker branches can propose configuration changes. Registration identifies a project but cannot authorize host execution. A policy may also change between acceptance and dispatch.

## Decision

Use strict, versioned JSON contracts for portable role/hook settings and separate project-bound host execution policy. Read repository configuration only as an untrusted proposal. The host/operator explicitly authors the approved project baseline outside repositories. No import, detection, or initialization silently grants execution permission.

Resolve defaults, user, approved project, local and request layers in that order. Merge declared object fields; replace arrays. Record the source of each effective leaf. Keep the user/local layers explicit in the project host document for the initial consumer; shared user-profile discovery is deferred.

Apply host-only execution enablement, runtime/command/environment allowlists, timeout ceilings, required hooks and exact skill approvals after merging. Commands use absolute executables and fixed argv; portable files only reference names. Prerequisite checks inspect executable availability, environment presence and protected skill bytes without executing commands.

Persist policy revision, full policy content digest, effective configuration/provenance, request overrides and skill pins in the accepted job JSON. Include the snapshot in job idempotency. Preserve the existing fingerprint for legacy jobs without snapshots. No SQL schema migration is required for the optional JSON field.

Before dispatch, resolve again from the same explicit project/checkout and compare snapshots. Refresh revocation and prerequisites; block on changes. Legacy jobs cannot dispatch automatically. The gate is an observation, not a capability or a replacement for attempt/SHA/provider/resource validation.

## Consequences

A pull request can propose settings without granting host permissions. Different technologies and future runtimes share the same configuration contracts. Host command arguments, environment values and skill source paths are omitted from public results and persisted job snapshots.

The first CLI consumer inspects configuration; library consumers can accept jobs with snapshots and evaluate dispatch preconditions. Runtime execution, service dispatch, hook execution and configuration initialization remain separate issues.

The host/operator currently maintains a private project policy file manually. Proposals differing from its approved project patch block, including otherwise harmless changes. Full policy changes invalidate the saved snapshot, even when unrelated to the selected role. This favors clear, explicit acceptance over automatic grandfathering; narrow policy compatibility rules can be introduced when a concrete dispatcher needs them.

Host files, command dependencies and same-user writers must be trusted/coordinated. Checking an executable does not sandbox it, pin its bytes, or make asynchronous observations atomic. A future dispatcher must recheck and consume the exact trusted command definition covered by its policy digest before effects.
