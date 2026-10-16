# ADR 0004: Owned worktree intent and recovery

Date: 2026-10-17

Status: Accepted

## Decision

Commit immutable worktree intent before filesystem/Git effects. Allocate private containers outside source checkouts, retain ownership markers outside Git status, and verify actual provider/filesystem evidence before recording readiness. Register allocated checkout identities and attempt-bound resources atomically with readiness.

Serialize lifecycle writers through durable phase/revision claims. Do not expire a pending claim into permission to repeat a Git write. Until a coordinator can prove provider quiescence, require an explicit operation-bound trusted host attestation for manual reconciliation. Label it as an assertion, not observed process shutdown. Reconciliation reads evidence and settles state without relaunching Git writes.

Before routine removal, recheck owned identity, branch/SHA retention, tracked/untracked/ignored files, locks, and known attempt resources. Never force-remove, prune, recursively delete uncertain paths, or delete task branches. Preserve partial and unknown resources, including unmarked bootstrap containers and branch-only partial creation.

## Consequences

Repeated requests can verify/reuse a ready resource without starting another writer. Interruptions retain useful ownership/effect evidence. Manual recovery requires correct host quiescence confirmation; fully automatic recovery remains a later coordinator responsibility. Git/filesystem checks require cooperating writers and trusted roots and cannot guarantee protection against adversarial path replacement or ignored-file creation races.

See [the worktree contract](../worktrees.md) for implemented operations, preconditions, result evidence, cancellation, and recovery limits.
