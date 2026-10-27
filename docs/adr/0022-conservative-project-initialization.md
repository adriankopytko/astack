# ADR 0022: Compose conservative, explicit project initialization

Status: accepted

## Context

Registration alone does not prepare project guidance, configuration or provider space. A convenience initializer must preserve authored setup and partial effects without converting repository proposals into execution permission. Generic hook execution is not yet implemented.

## Decision

Add an explicit, noninteractive initialization operation and CLI with a read-only preview. Resolve one repository through existing identity/selection contracts. Hold coordinator ownership for apply, register before effects, and compose managed-file, skill and Herdr operations using their existing durable intents. Recheck identity and branch/HEAD at stage boundaries. Do not add a second initialization journal or infer ownership from aggregate completion.

Create conservative null repository proposals and a disabled private host-policy starter only where safe. Preserve existing authored/edited/deleted/foreign/pending setup. Existing authored private policy also preserves an absent repository proposal. Never copy private execution settings into source files. Selected project guides use mode 0644 under `.agents/skills`, preserving provenance across Git checkouts; user installation defaults remain separate. Inspect user orchestrator availability without modifying global setup.

Herdr primary-space setup requires an explicit or saved target and retains existing settings on conflicts. Do not create workers. Detect manifests and declared script names as suggestions only; do not execute hooks, install dependencies, launch agents, mutate trackers or enable review automation.

## Consequences

Initialization can finish while delegation remains blocked. A partial result keeps successful component receipts, and retries inspect/reuse known completed stages. Pending file/provider effects require their established recovery contracts, never an automatic replay. Project metadata can be committed after successful publication, while operational journals/stages remain excluded. No batch atomicity is promised. Contributor and CLI details live in [the initialization contract](../initialization.md).
