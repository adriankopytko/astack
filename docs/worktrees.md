# Owned worktree lifecycle

## Implemented scope

Issue #13 adds `prepareWorktree`, `inspectWorktree`, `removeWorktree`, and `reconcileWorktree`, with matching `astack worktree` commands. These operations create isolated Git checkouts, persist ownership, and preserve uncertain or unsafe resources. They do not launch agents, provision applications, run project hooks, close workspaces, allocate ports, or publish GitHub objects.

```sh
astack worktree prepare --project example --key task-42 \
  --branch astack/task-42 --base <full-local-commit-sha> --json
astack worktree inspect <worktree-id> --json
astack worktree remove <worktree-id> --json
```

Host `--state-directory` and `--git-executable` options are shared with project commands. Commands target registered identity or an owned worktree ID independently of caller cwd. The library requires full `refs/heads/...` branch names; the CLI also accepts short branch names and normalizes them.

## Inputs, bindings, and dependencies

`prepareWorktree({ schemaVersion: 1, projectId, checkoutId?, runId?, key, branch, baseCommit }, dependencies, signal?)` requires:

- A deliberately registered project/source checkout with freshly verified Git and filesystem identity. Omitted checkout selects the primary; a supplied saved attempt binds its recorded source.
- A full local commit SHA. It must resolve to that exact commit, not an annotated tag object or a branch name. No fetch occurs.
- A new task branch. Existing branches are never adopted, reset, or deleted. The owner key is stable within the project and cannot be retargeted to a different checkout, branch, base, saved attempt, or managed root.
- An explicit trusted managed root outside source repositories. The CLI uses `<state-directory>/worktrees`; library callers supply the equivalent host location. Its parent must already be a private, owned directory. No project or PR configuration selects it implicitly.

`runId` optionally identifies an existing persisted attempt. Project/repository/source checkout, branch, and base must agree with its assignment. The record retains the job/attempt binding plus the newly allocated checkout ID. A standalone invocation uses a manual project-scoped owner key with `run: null`; it does not fabricate a job or attempt. Worker authorization and dispatch remain later application operations.

Dependencies are explicit ports: project registry, Git inspector, filesystem identity reader, `WorktreeStore`, `WorktreeFiles`, and `WorktreeGit`, plus managed root, clock, and IDs. The concrete factories are `createNodeWorktreeFiles` and `createWorktreeGit`; `openSqliteState` returns `worktrees` sharing the existing connection, closed through `store.close()`. Imports and factory construction perform no effects.

Inspect/remove accept `{ schemaVersion: 1, id }`. Reconcile additionally requires the exact `operationId` and `writerStopped: true`; see recovery below. Exported schemas validate inputs, records, and structured results.

## Ownership before effects

Migration 3 introduces an immutable worktree intent and lifecycle journal. It retains project/repository/source checkout IDs, optional job/attempt assignment, allocated checkout ID, owner key, branch, full base SHA, paths, source filesystem identity, marker token, operation ID, revision, and phase. Existing migrations remain unchanged.

An atomic reservation commits before directory creation, branch creation, or checkout materialization. Uniqueness constraints cover project/key, repository/branch, and checkout path. Only the caller receiving a newly created reservation may launch creation. Concurrent or repeated requests for a pending reservation return pending; no age/lease expiry launches a replacement writer.

The managed layout is:

```text
<state-directory>/worktrees/<worktree-id>/
  ownership.json
  checkout/
```

The private container is created exclusively. Its mode-0600 marker binds the immutable intent digest and a unique token, and lives outside the Git checkout. Root/container directories must be canonical, private, user-owned directories. Symlinks, unknown/edited markers, and unexpected layouts are refused. A marker is collision/ownership evidence inside a trusted host directory, not authentication against malicious code running as the same user.

After Git returns successfully, inspect its registration, named branch, exact initial base commit, common-directory identity, clean tracked/untracked status, and ignored files. Only then persist `ready`, register the allocated checkout, and, for an attempt-bound resource, retain its worktree resource record in one transaction. Repeated prepare verifies current ownership and cleanliness before returning `reused`; later commits on the same task branch may be retained and reused.

## Removal

Removal claims the ready record with a new operation ID and revision, retaining the observed HEAD as `removalCommit`. Live dependent worktrees and unresolved attempts using the allocated checkout block removal. An attempt-bound checkout also requires a terminal stored result and no other retained resources for that attempt. This is a conservative storage gate, not proof that a worker stopped: runtime adapters/host callers must separately verify provider quiescence and release the correct handles. Standalone callers must coordinate their own editors, workers, and services.

Immediately before the Git write, repeat ownership, directory identity, Git membership, branch/SHA, lock/prune, tracked/untracked status, and ignored-file checks. Both ordinary and ignored files block cleanup. An externally switched branch, detached HEAD, changed directory identity, edited marker, locked/prunable worktree, or incomplete evidence preserves the resource. Source checkout identity is also rechecked; no automatic switch to another source occurs.

Run only `git worktree remove` without force. There is no recursive filesystem deletion, task-branch deletion, remote branch deletion, unlocking of user locks, or worktree pruning. Git can additionally refuse initialized submodules or other unsupported states; retain pending evidence rather than forcing removal.

After removal, verify both checkout-path absence and Git-registration absence, and verify the task branch still references the recorded removal commit. Then persist `removed` and release the corresponding attempt worktree resource atomically. Container/marker and historical checkout registration remain for audit/recovery; retention cleanup is later work. A removed checkout ID resolves as stale if selected as a live checkout. Repeated removal verifies the retained evidence and does not launch another removal.

Cleanliness/identity checks and Git removal are not a filesystem compare-and-swap. An uncoordinated editor could create an ignored file after the final check; Git's own removal behavior is not an independent guarantee that such ignored files survive. Use trusted roots and cooperating writers, and establish quiescence before cleanup. This primitive does not claim to detect escaped descendants, unrelated listeners, or all change-and-revert/inode-reuse races.

## Interrupted effects and manual reconciliation

Phases are `preparing`, `ready`, `removing`, `removed`, and `abandoned`. A failure, timeout, cancellation, incomplete process evidence, unexpected exit, or failed post-effect check can leave a durable pending record. An uncertain state commit returns `uncertain`; reopen and inspect before acting. Never interpret provider failure as proof that no branch/checkout changed.

Recovery is deliberately explicit:

```sh
astack worktree inspect <id> --json
# After the trusted host/operator has verified that the original writer AND its children stopped:
astack worktree reconcile <id> --operation <current-operation-id> --writer-stopped --json
```

`--writer-stopped` is a trusted host attestation, recorded as `host-attestation`; Astack does not infer or verify process quiescence from this flag. Do not generate it automatically from PID absence, age, agent idleness, a clean tree, or a Git registration. Do not take it from proposed PR configuration or an untrusted worker report. A future coordinator must provide verified process/provider evidence before making this decision. An incorrect attestation can release coordination while the old writer still runs.

Reconciliation performs fresh reads and a guarded state transition; it never reruns Git creation/removal:

- A complete, clean, owned checkout at the intended initial base can finish interrupted preparation.
- No checkout, Git membership, or task branch can settle an interrupted prepare as `abandoned`. The owner key remains reserved; a new attempt requires a new key/branch.
- A branch-only partial creation is retained, without adopting or deleting the branch.
- An absent checkout/registration with preserved expected branch can finish interrupted removal.
- A still-present, verified checkout can restore `ready` after an interrupted removal, requiring a separate explicit remove request later.
- Unknown, dirty, edited, mismatched, or partial resources stay blocked/pending. An unmarked container from a bootstrap crash is not automatically adopted or deleted, even if empty.

The exact operation ID prevents a stale assertion from settling a newer writer. State revisions prevent competing finalizers from silently replacing each other's observations. This provides recoverable evidence and controlled manual settlement, not exactly-once external execution or automatic crash recovery.

## Git execution and cancellation

Git uses a trusted absolute executable, explicit argv/cwd, a controlled environment, disabled hooks/fsmonitor/submodule recursion/lazy fetch, no network protocols, and bounded process output. Configured nonempty clean/smudge/process drivers and sparse checkout are rejected before worktree effects until an explicit execution profile supports them. Global/system Git configuration is excluded, matching the Git inspector; raw Git output, diagnostics, and environment dumps are not persisted or returned.

Use trusted repositories under the [Git inspection preconditions](git-inspection.md). The current preflight is not a sandbox or an atomic policy snapshot against hostile configuration replacement. Global-only filters are absent from the controlled configuration; this operation does not provision Git LFS or promise profile-specific materialization. Submodule initialization and project setup remain separate operations.

Default Git command timeout is 30 seconds (maximum 120 seconds), with 1 MiB capture per stream. Every read requires complete, untruncated, valid UTF-8 evidence. Independent Git/filesystem verification steps add latency; no whole-operation real-time deadline is promised. No external write retries automatically.

Validation precedes cancellation. Before reservation, cancellation rejects without an owned-resource intent. After reservation, preserve pending evidence; cancellation before a removal write can restore ready state. Once Git may have changed resources, perform bounded verification without relabeling verified completion as cancellation. Shutdown evidence does not establish that arbitrary escaped processes/services stopped.

## Results and verification

Results use `schemaVersion: 1` with `prepared`, `reused`, `removed`, `reconciled`, or `inspected` plus record/observation; `blocked`/`pending` include a stable reason and retained record. Validation/source/storage rejections use the existing error envelope; an uncertain storage commit keeps `state_write_uncertain`. CLI exit is 0 for completed observations/actions and 1 for blocked/pending/rejected/uncertain. An inspected pending record is not a ready resource.

Disposable verification covers preparation/reuse, concurrent reservation, automatic checkout registration, subsequent commits and branch retention, dirty/untracked/ignored preservation, locks and marker edits, unowned rejection, process exits after creation/removal, explicit recovery binding, absent/branch-only/unmarked partial creation, active attempts and retained-resource gates, CLI use from neutral cwd, cancellation, and unsupported filters. No live agents, user repositories, or GitHub mutations are used.

Git mechanisms follow [git-worktree](https://git-scm.com/docs/git-worktree) and the [ignored-file listing interface](https://git-scm.com/docs/git-ls-files). See also [ADR 0004](adr/0004-owned-worktree-intent-and-recovery.md).

Removal checks retained resources for every job associated with the checkout, even when the worktree intent originally had no bound attempt. A completed worker result or completed host publication attempt does not clear worker holds. After publication and explicit worker shutdown reconciliation are settled, normal removal can proceed; branches and historical reports remain preserved.

## Cleanup orchestration

[Durable cleanup](cleanup.md) wraps this primitive with frozen run/report/SHA authority, retention, publication policy, shutdown verification and a nonexpiring cleanup claim. Its optional internal authority argument to `WorktreeStore.beginRemoval` is checked transactionally with removal intent against the observed HEAD. Ordinary manual worktree commands keep their existing contract. Cleanup never broadens this primitive's ownership, cleanliness or recovery rules.
