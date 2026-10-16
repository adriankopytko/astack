# ADR 0003: Explicit project registration and context

Date: 2026-10-17

Status: Accepted

## Decision

Separate durable project, repository, and checkout identities. Register checkouts deliberately after canonical Git inspection, and retain host filesystem identity observations to detect stale/replaced paths. Share one registered project across linked worktrees; keep independent clones separate. Do not infer identity from names or remote URLs.

Resolve explicit saved-attempt, checkout, project, and path selectors before caller-directory discovery. Require explicit selectors to agree; ambient cwd is not a conflicting assertion when an explicit target is present. Never scan a collection directory to guess a project. Saved-attempt assignments remain separate from freshly observed HEAD.

Allow diagnostics without registration or state initialization. Registration establishes local identity, not permission to execute repository configuration, launch an agent, or clean up resources. Configuration provenance and unavailable provider/delegation capabilities must remain explicit.

## Consequences

The CLI can reliably target another project from a neutral or unrelated directory. Linked checkout registration and read-only diagnostics share library operations. Movement/replacement requires later explicit reconciliation rather than automatic adoption. Trusted execution policy, runtime authority, and worktree ownership remain separate operations.

See [the project contract](../projects.md) for implemented APIs, selection rules, state migration, and consistency limits.
