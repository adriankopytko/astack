# ADR 0018: Explicit after-handoff review dispatch

- Status: accepted
- Date: 2026-10-24

## Context

An accepted implementation can authorize one exact follow-up review, and shared CI observation can wait for readiness. Scheduling that review needs separate host controls, dedicated checkout ownership, crash-safe linkage and a clear disable/resume contract.

## Decision

Migration 13 persists project automation controls (disabled by default) and one immutable plan per accepted follow-up. Require the orchestrator to attach a dedicated already prepared owned reviewer checkout at the exact handoff SHA. No arbitrary PR discovery, implicit checkout provisioning, agent allocation before readiness or automatic repeat is added.

Enable the executor through a separate service opt-in requiring CI observation. Use owned CI generations and a bounded event-woken dispatcher. Validate source, policy and ownership before enrollment/acceptance; guard CI intent acceptance, review queue linking and worker claim inside SQLite transactions. Link queue intent and plan atomically, and mark dispatch with capacity claim. Preserve task/run identity across pause/resume.

Project disablement suspends eligible plans and owned waits atomically. Enabling exposes the backlog for explicit resume. A host started without the executor also suspends eligible saved plans before dispatch; restoring the flag does not replay them. Resume creates a new CI generation, retains the exact target/binding and requires fresh policy/readiness checks. Existing manual requests remain available and never implicitly become paused automatic work.

Automatic tasks carry explicit after-handoff provenance and prompt version 4. Keep manual version 1/2/3 bytes unchanged. Require native runtime authorization at reservation and immediate launch/initial-input boundaries. Already delivered work is not cancelled by automation controls; cancellation and cleanup remain independent run/resource operations.

## Consequences

One orchestrator can hand off an implementation, bind its independent reviewer checkout and let the service handle authorized waiting and dispatch. No worker needs to create a reviewer. Explicit preparation remains a step until a separate provisioning consumer is implemented.

SQLite and external providers cannot share a transaction: previously authorized effects can finish after disable, and blocked/unknown claimed attempts remain retained for inspection rather than automatic retry. A compatible existing manual review may satisfy a plan without changing its ownership. See [the complete contract](../automatic-review.md) for bounds, restart, disable/resume, authorization and verification limits.
