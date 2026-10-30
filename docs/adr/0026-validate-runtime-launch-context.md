# ADR 0026: Validate approved launch profiles before native startup

Status: Accepted

## Context

An approved host command and a successful Herdr CLI response do not establish that the server pane resolved the same executable, environment or native configuration. Project configuration can override user defaults. Failed validation must not cause automatic duplicate workers, and provider-specific model/configuration settings do not belong in generic workflow policy.

## Decision

Store optional runtime-keyed launch profiles under private role execution policy. A provider-specific validator interprets their settings through an injected port. New Codex launches require explicit model/reasoning, executable/version and environment/file provenance approval. Existing role argument restrictions stay intact; unrestricted config/native profile overrides remain unsupported.

Reserve the existing durable runtime session/resource with one pending validation invocation before probes. Execute the installed configuration validator on the host and in the exact owned empty pane; correlate a fresh successful marker and compare context evidence. Refresh policy and checkout before recording validated digests and making the single native launch call. Validation is parser/provenance evidence, not sandbox enforcement or worker readiness.

Repeated starts never replay a pending invocation. Incomplete validation cannot bind an external detected agent. Reuse/input require saved profile/argument evidence and current host context. Preserve uncertain launches, legacy history, authored configuration and all resource holds. No global/project settings are rewritten, and no native-profile asset installer or reset command is introduced.

## Consequences

New startup requires deliberate host configuration and compatible installed-agent commands. Validation executes bounded probes and adds startup latency. Protocol 22 still lacks atomic target guards; shell/ambient extensions, credentials and OS policy remain host trust. Context observations are not atomic filesystem snapshots and cannot exclude a hostile same-user race. A changed launcher dependency must be included in the approved file inventory. Failed validation needs deliberate operator recovery under the existing writer-exclusion/shutdown contracts, not an automatic retry.
