# Git inspection

## Implemented API

`inspectGitRepository(request, inspector, signal?)` is a versioned, read-only library operation. Create the Git adapter with `createGitInspector({ executable, runner, timeoutMs?, maxCaptureBytes? })`; supply an absolute trusted Git executable and a `ProcessRunner`, normally `nodeProcessRunner`. Construction/imports perform no provider calls. There is no Git inspection CLI command yet.

```ts
const inspector = createGitInspector({
  executable: '/usr/bin/git',
  runner: nodeProcessRunner,
});
const result = await inspectGitRepository(
  { schemaVersion: 1, path: '/projects/example/src', baseRef: 'refs/heads/main' },
  inspector,
);
```

The executable location is host configuration; this example does not prescribe a portable installation path. The injected `GitInspector` port also supports alternative readers without coupling application operations to Git subprocesses.

## Inputs and preconditions

- `path`: explicit absolute existing directory. Nested directories and symlink aliases resolve to the canonical checkout. No ambient cwd selects a repository.
- `baseRef`: optional `HEAD`, a fully qualified ref, an unambiguous shorthand ref name, or a full lowercase SHA-1/SHA-256 object ID. Revision expressions, ranges, reflogs, option-like inputs, and abbreviated object IDs are unsupported. Omission returns `base: null`; no default branch or remote is inferred.
- A working checkout is required. Bare repositories and paths inside Git metadata directories are rejected. Linked worktrees, unborn branches, and detached HEADs are supported.
- Use a trusted repository and executable. This is not a sandbox for hostile Git configuration, executable wrappers, filesystem replacements, or configured content filters. Git repository ownership/access checks remain in effect; the adapter does not set `safe.directory=*`.
- Linux/macOS support follows the process runner. Git 2.45 or later is required, including the explicit `--no-lazy-fetch` flag; unsupported installations fail rather than falling back to human-readable parsing. The tests exercise the installed Git.

## Facts returned

A successful read returns `{ schemaVersion: 1, outcome: 'completed', value }`:

| Field                        | Meaning                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository.commonDirectory` | Canonical local Git common directory. Linked worktrees share it; independent clones have different directories even with identical remotes/history.                                     |
| `repository.objectFormat`    | Storage object format: `sha1` or `sha256`. Object IDs are full length.                                                                                                                  |
| `checkout`                   | Canonical root and per-checkout Git directory, plus full branch ref or null for detached HEAD, and commit or null for an unborn branch.                                                 |
| `refs`                       | Sorted local ref names, object IDs, and object types. Annotated tag objects remain tags here.                                                                                           |
| `base`                       | Requested selector, resolved full ref when applicable, and peeled commit ID. Annotated tags resolve to their commit; tree/blob targets reject. `HEAD` is pinned to its observed commit. |
| `remotes`                    | Configured names and fetch/push endpoint summaries containing only transport, host, and optional port.                                                                                  |
| `worktrees`                  | Registered worktree paths, full HEAD IDs when available, branch, detached/bare state, and locked/prunable flags.                                                                        |
| `status`                     | Cleanliness and tracked/untracked entries, with index/worktree status, rename source when applicable, and submodule state. No file contents or diffs.                                   |

`commonDirectory` is a local identity observation, not a globally unique repository ID, durable registration, or ownership proof. Directory moves/replacements require later reconciliation. The project registry will assign durable IDs separately.

Worktree paths describe Git's registry. They are not necessarily accessible, canonical, current, or owned by Astack. Only the selected checkout and its Git/common directories are canonicalized and anchored. Missing registered worktrees remain visible with Git's prunable flag; inspection never prunes them. Lock/prune reasons are omitted.

Status uses NUL-delimited porcelain v2 with all untracked files, submodule dirtiness enabled, fixed rename threshold, and no ahead/behind traversal. Filenames with spaces, tabs, and newlines remain literal. Ignored files are excluded. An untracked nested repository can appear as an opaque directory ending in `/`; it is not recursively inspected. A clean result therefore does not prove absence of ignored files, external services, or other resources. Consumers must not derive removal permission from cleanliness.

The text process interface cannot losslessly represent arbitrary filesystem bytes. Truncated/incomplete streams, mismatched byte counts, and replacement characters reject the observation; this conservatively also rejects a literal Unicode replacement character. No partial output is accepted as a complete list.

## Ref resolution

Shorthand lookup considers `refs/<name>`, `refs/tags/<name>`, `refs/heads/<name>`, `refs/remotes/<name>`, and `refs/remotes/<name>/HEAD`. Multiple matches reject with `base_ref_ambiguous`; the caller must choose a fully qualified ref. A full object ID colliding with a matching ref is also ambiguous. Pseudorefs other than `HEAD` are unsupported.

The adapter pins a named ref to its observed object ID before peeling it to a commit. It does not fetch missing refs or objects. A missing local target rejects with `base_ref_not_found`; an existing target that cannot be peeled to a commit rejects with `base_ref_not_commit`. Symbolic refs outside the returned ref list do not receive special implicit handling.

## Effects and execution controls

Every invocation uses explicit argv/cwd and a fresh controlled environment. It does not inherit `GIT_DIR`, `GIT_WORK_TREE`, config injection, tracing, credentials, or other caller environment variables. The adapter disables system/global Git config, replacement objects, optional locks/index refresh writes, lazy object fetching, terminal prompts, fsmonitor, hooks, and the untracked-cache optimization. Local repository configuration and applicable includes still describe the repository; endpoint summaries reflect configured URLs, not `insteadOf` rewrites or a verified destination.

There are no network operations, ref writes, worktree creation/removal, branch deletion, ownership records, or durable acceptance. Commands capture bounded output in memory and create no output artifacts. Raw Git diagnostics and raw remote URL values are never returned or logged by Astack. The injected runner is trusted: any extra logging or artifact capture it adds is its caller's responsibility.

Remote summaries deliberately omit usernames, passwords, repository paths, query strings, fragments, and local filesystem locations. Recognized HTTP/HTTPS/SSH/Git URLs and SCP syntax yield host/transport facts; local URLs yield `file` without a path; unsupported helpers/malformed URLs yield `other` without a host. Push lists include explicitly configured `pushurl` values only; an empty list does not imply pushing is disabled. These facts cannot identify or authorize a GitHub repository. Names, hosts, refs, and file paths remain project metadata; apply the caller's disclosure policy before publishing them.

The default total command budget is 10 seconds (configurable from 1 to 120,000 ms). Each successive command receives the remaining budget. Capture defaults to 1 MiB per stream per command, with the process contract's 16 MiB maximum. Any truncated stream rejects the read. Filesystem calls and bounded process teardown can add latency beyond the command budget; this is not a hard real-time deadline.

## Consistency, errors, retry, cancellation

Before returning, the adapter repeats status, refs, worktree registration, and selected checkout path facts, and rechecks directory identities. Detected changes reject with `repository_changed`. These checks cannot provide an atomic Git/filesystem snapshot or detect every change-and-revert race. Consumers must recheck identity, branch/SHA, cleanliness, and resource ownership immediately before any effect; never treat this read as a lock or cleanup authorization.

Errors use the standard rejected envelope and fixed messages without raw provider diagnostics:

| Code                                                               | Caller action                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `invalid_request`, `unsupported_contract_version`                  | Correct request or inspector configuration.                                               |
| `path_unavailable`, `not_git_repository`, `unsupported_repository` | Select an accessible working checkout.                                                    |
| `git_unavailable`, `unsupported_platform`                          | Fix executable/platform configuration.                                                    |
| `git_failed`                                                       | Check repository access, Git ownership policy, local configuration, or Git compatibility. |
| `git_timed_out`, `git_output_incomplete`                           | Adjust time/capture budgets and inspect again.                                            |
| `invalid_git_output`                                               | Resolve unsupported/lossy provider output; do not consume a partial observation.          |
| `base_ref_not_found`, `base_ref_ambiguous`, `base_ref_not_commit`  | Select an existing explicit commit target.                                                |
| `repository_changed`                                               | Inspect again after concurrent activity settles.                                          |
| `cancelled`                                                        | No complete observation is available.                                                     |

There are no automatic retries. Read retries are safe within the stated trusted-repository preconditions, but may observe different facts. A pre-aborted request invokes no reader; in-flight cancellation is forwarded to the runner and returns no partial facts after termination handling. Ordinary provider exceptions are converted to fixed `git_failed` errors.

## References and verification

The parsers follow Git's [porcelain v2 status](https://git-scm.com/docs/git-status#_porcelain_format_version_2), [NUL-delimited worktree format](https://git-scm.com/docs/git-worktree#_porcelain_format), [ref enumeration](https://git-scm.com/docs/git-for-each-ref), [revision verification](https://git-scm.com/docs/git-rev-parse), and [NUL-delimited configuration format](https://git-scm.com/docs/git-config).

Isolated verification uses disposable repositories for normal/nested/aliased paths, linked worktrees, independent clones, explicit/ambiguous/missing/non-commit refs, annotated tags, detached/unborn HEADs, SHA-256 IDs, index preservation, unusual file names, remote credential removal, controlled execution, incomplete output, cancellation, and concurrent changes. No user repositories, remote providers, or agents are mutated.
