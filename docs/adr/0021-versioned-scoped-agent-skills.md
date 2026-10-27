# ADR 0021: Versioned role skills with deliberate user setup

Status: Accepted

## Context

The command guide exposes the CLI, but one orchestrator and its workers need different instructions. Workers must receive the assigned run/result scope without inheriting publication, dispatch or cleanup responsibilities. Reusing the tooling outside a project also requires a discoverable user-level guide and safe updates that preserve authored skills.

## Decision

Keep `astack --skill` as the complete installed command guide. Ship separate namespaced orchestrator, implementer and reviewer SKILL.md assets with individual versions and a strict digest catalog. Add `skills list/show/inspect/install` through injected bundle, directory and managed-file ports. Resolve assets from the installed package rather than cwd.

Use the selected skills root; the CLI defaults to the Codex user skills directory and allows an explicit compatible root for other agents/profiles. Installation is deliberate, independent from project registration/service startup and future project initialization. The future init operation can report availability through the same read-only inspection API. No agent settings or execution policy are rewritten.

Reuse managed-file intent, ownership, collision and pending-write evidence. Preflight all selected roles, preserve authored/edited/deleted targets and unresolved claims, and stop after a partial/unknown write. Each role is a self-contained atomic file publication; the bundle installation is not atomic. A changed asset under an already-installed version conflicts. Skill pins, configuration approvals, accepted job snapshots and saved runtime prompt bytes remain independent and unchanged.

## Consequences

An orchestrator can discover current supported behavior anywhere, while workers use narrow assignment/report guidance. Package users can inspect versions and update only owned unchanged assets. Unknown writes remain inspectable, never force-adopted. Host roots and cooperating writers are still trusted; skills are workflow instructions rather than a sandbox or permission grant. No project init, automatic worker binding, broad catalog or settings migration is introduced.
