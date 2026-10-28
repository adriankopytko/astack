# ADR 0024: Execute host-approved lifecycle hooks through durable invocation intent

Status: accepted

## Context

Projects need technology-specific setup, verification and bounded service controllers. Existing configuration names hooks but does not execute them. Shared allocations must precede startup and remain held through uncertainty; worker results or process-group absence cannot authenticate application shutdown.

## Decision

Add explicit setup/verify/start/teardown operations using the process runner and injected host environment/resource ports. Retain existing phase names; make start optional without changing old defaults or saved prompt bytes. Repository configuration selects names only; private host policy approves exact command argv, deadlines, environment names and allocation-field bindings. Require ready owned checkout identity, explicit current SHA and writer exclusion, refreshing policy/target before process effects.

Journal immutable attempt/key intent, claim once, append events and retain cleanup holds transactionally. Start hooks consume newly confirmed allocator startup receipts; partial claims and unknown execution never replay. Persist bounded sanitized process/endpoint evidence, discarding output text and environment values. Gate worker dispatch on declared setup/start evidence and verified independent resources; static reviews skip service setup, while integration reviews use only their own declared reservations.

Separate original-controller exclusion from verified service shutdown. Explicit writer exclusion can mark a crashed executing invocation unknown so teardown can run, but cannot release resources. After independently verified shutdown and allocation release, reconcile the exact hook hold without rerunning commands. Keep native worker cleanup and worktree removal separate. Add no startup hooks, periodic scanners, unrestricted command RPC, automatic publication verification or provider-specific provisioning.

## Consequences

Projects retain authored technology choices and partial setup evidence. Hooks are host effects, not an OS sandbox; trusted scripts can themselves mutate project setup. Extra explicit shutdown steps preserve escaped or uncertain resources. Publication verification consumes this evidence in #33; automatic lifecycle scheduling and agent environment injection remain separate. See [hook contracts](../hooks.md).
