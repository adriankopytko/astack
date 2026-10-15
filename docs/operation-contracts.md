# Operation contracts

The executable contracts below implement issue #7. The durable model later in this document is the design for subsequent operations; it is not an implemented service or a set of runnable commands.

The effectful `executeProcess` operation from issue #8 has a separate [process execution contract](process-runner.md) and result schema. Its timeout/cancellation outcomes retain shutdown uncertainty instead of using the completed-read envelope.

## Versioning and read results

Requests carry integer `schemaVersion: 1`. Result envelopes carry their own `schemaVersion: 1`, independent of the package version. Missing or malformed versions are `invalid_request`; an otherwise readable positive integer version other than `1` is `unsupported_contract_version`. No automatic version coercion, field stripping, or downgrade occurs. The version check precedes operation-field validation.

Results for the two implemented read operations are:

```ts
type OperationResult<T> =
  | { schemaVersion: 1; outcome: 'completed'; value: T }
  | { schemaVersion: 1; outcome: 'rejected'; error: { code: OperationErrorCode; message: string } };
```

Exported schemas validate decoded JSON. Their inferred types describe valid requests/values; operation entrypoints accept `unknown` so invalid callers receive a structured rejection. The result schemas reject extra fields, unsupported versions, missing values, and invented outcomes such as `accepted`. Imports perform no IO.

Only the error codes are stable programmatic diagnostics. Do not parse messages. Public rejection messages contain neither input values nor source exception text. No implicit retry occurs. A rejected read has not accepted or created durable work. Future effectful operations need their own evidence and uncertain-effect contract, not an assumption that every error means nothing happened.

## Package inspection

Library: `getApplicationInfo({ schemaVersion: 1 }, version)`.

CLI: `astack info` or `astack info --json`.

| Contract      | Behavior                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Inputs        | Versioned empty request; injected nonempty package version                                            |
| Preconditions | The caller has validated the installed package version; the CLI reads its package manifest at startup |
| Effects       | No filesystem/provider/state reads inside the operation; the CLI renders the returned value           |
| Evidence      | Package name, package version, and scaffold stage only                                                |
| Rejection     | `invalid_request` or `unsupported_contract_version`                                                   |
| Retry         | Safe to repeat; no identity allocation or external effect                                             |
| Cancellation  | Synchronous read; no accepted background work to cancel                                               |

Example JSON output:

```json
{
  "schemaVersion": 1,
  "outcome": "completed",
  "value": { "name": "astack", "version": "0.1.0", "stage": "foundation" }
}
```

The CLI uses exit code `0` for a completed operation and `1` for an operation rejection. The JSON result occupies stdout without extra prose. Command syntax/help/version processing remains Commander's CLI behavior; it is not a durable operation response. Installation/startup failures are separate from accepted work. Plain `info`, help, version, and `--skill` keep their distinct human/agent output formats.

## Explicit project context resolution

Library only: `resolveProjectContext(request, reader, signal?)`.

```ts
const request = {
  schemaVersion: 1,
  projectId: 'project-a',
  // checkoutId: 'checkout-linked' // optional explicit alternative
};
```

`ProjectContextReader` supplies two read-only projections. These are operation inputs, not promised registry/database storage formats:

```ts
// readProject(projectId, signal?): Promise<unknown>
{ id: 'project-a', primaryCheckoutId: 'checkout-main' }

// readCheckout(checkoutId, signal?): Promise<unknown>
{
  id: 'checkout-main',
  projectId: 'project-a',
  repositoryId: 'repository-a',
  rootPath: '/work/project-a',
  gitCommonDirectory: '/work/project-a/.git'
}
```

Return `null` when absent. Other values are schema-validated. Reader IDs must match the requested IDs, and the checkout must belong to the selected project. Unknown fields are rejected; adapters must project records to this narrow shape.

IDs are opaque ASCII tokens of 1–128 characters: an initial alphanumeric followed by alphanumerics, `.`, `_`, `:`, or `-`. Their separate TypeScript brands prevent accidental assignment between identity types. They are not names, paths, remote URLs, or authorization tokens. Absolute host paths must contain no NUL characters. Syntax validation cannot establish canonicality, Git identity, current existence, trust, or ownership; the reader is responsible for its recorded facts and later effectful operations must freshly inspect resources.

| Contract      | Behavior                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Preconditions | An explicit registered project ID and a read-only reader; no default project is inferred                                                   |
| Selection     | Explicit checkout ID when supplied; otherwise the project's recorded primary checkout ID                                                   |
| Effects       | Reads project, then checkout; no registration, adoption, filesystem mutation, Git execution, or provider launch                            |
| Evidence      | Validated project/checkout projections and `primary-checkout` or `explicit-checkout` selection source                                      |
| Retry         | Repeating a read re-observes facts; success is not a lease or a durable snapshot                                                           |
| Cancellation  | Checks the signal before reads and after each await; passes it to the reader. Interrupting an outstanding read requires reader cooperation |

Errors:

| Code                           | Meaning and next step                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `invalid_request`              | Fix the request shape; no reader calls occurred                                          |
| `unsupported_contract_version` | Use a supported contract version; no reader calls occurred                               |
| `project_not_found`            | Explicitly register/select the intended project using future registration operations     |
| `checkout_not_found`           | Reconcile/select the intended registered checkout                                        |
| `checkout_project_mismatch`    | The checkout belongs to another project; do not silently reassign it                     |
| `invalid_context_source`       | Repair inconsistent, mismatched, or malformed reader projections                         |
| `context_source_unavailable`   | Restore the reader and explicitly retry; original exceptions are not returned            |
| `cancelled`                    | No result was accepted as completed; a later explicit read may retry with a fresh signal |

Validation takes precedence over cancellation. Cancellation during a read takes precedence over that read's returned value/error. A noncooperative reader can delay cancellation; no timeout or forced termination is promised here. Two source reads are not an atomic registry snapshot: a completed observation cannot authorize subsequent cleanup, publication, or worker launch.

The resolver never consults ambient cwd or providers. Production registration, nearest-repository discovery, run binding, conflicting selectors, and project-context CLI commands belong to later project/Git issues. A library consumer can supply an in-memory reader today and validate the same returned object with `projectContextResultSchema`.

## Durable v1 model — design only

No durable job, report, or service schema is exported yet. Add one with its consuming operation, including version migration and invalid-input tests. The following constraints govern that implementation.

### Identity, acceptance, and effects

- Bind a job to stable project/repository/checkout identity, role, requester, task or PR, effective policy revision, and creation time. Bind execution attempts separately to runtime/workspace/resource handles. IDs supplied in an environment variable alone do not authorize worker operations.
- A submission has an idempotency key scoped to requester/project/operation. Reusing it with the same intent returns the existing receipt; differing intent is a conflict. Intentional retry or repeat review gets an explicit attempt identity and retains lineage.
- Persist accepted intent and pending effects in one short transaction before acknowledgement. A receipt identifies the job and whether it is queued or already started. Neither acceptance nor process exit proves completed work.
- Execute provider effects after commit, persist handles/evidence as soon as known, and reconcile unknown effects before retry. Crashing between launch and handle persistence must not create another writer blindly. Exactly-once external execution is not promised.
- Keep transactions and claims short; do not await providers or hold a repository lock throughout an agent's run. Cancellation first prevents future dispatch; interrupt only verified owned workers and retain recoverable work.

### Separate state dimensions

| Dimension   | Facts to retain                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution   | Requested intent, queue reason, starting/running attempt, needs-decision blocker, completed/failed/cancelled/unknown outcome                            |
| Publication | Local committed SHA, pending push/PR effects, confirmed remote repository/PR/head, publication markers and interruption evidence                        |
| CI          | Requested SHA and gate policy, observed check identities/conclusions/time, next refresh/deadline, unknown/waiting/passed/failed/stale outcome           |
| Review      | No request, explicit or after-handoff intent, authorization, queued/suspended/running attempt, findings/result, reviewed SHA and current-head freshness |
| Cleanup     | Owned and retained resources, requested/stopping/removing/completed/blocked progress, verified shutdown and release evidence                            |

A completed implementation with pending CI and retained resources is valid. A cleanup blocker does not itself prevent review in an independent owned checkout. A completed review at an old SHA remains historical evidence, not current readiness. GitHub owns live issue/PR state; local state owns intent, attempts, observations, resources, and durable results. Labels/caches are not transactional locks.

Manual review initiation is default. An accepted handoff creates an automatic request only under explicit after-handoff policy. Observe only pending authorized targets with shared bounded schedules and API budgets. Recheck target SHA, PR state, effective automation controls, readiness, ownership, and capacity immediately before dispatch. Suspending automatic review does not prevent explicit manual requests and does not implicitly cancel running reviews. Resume of suspended work is explicit.

### Reports, SHA evidence, and artifacts

- Worker reports identify schema version, job, attempt, project, role, outcome, verification claims, artifacts, and next action/blocker. The service checks the authenticated worker binding and expected assignment before accepting them.
- Commit evidence uses a full hexadecimal object ID with the repository's hash algorithm: 40 characters for SHA-1 or 64 for SHA-256. Reject abbreviations, refs, PR numbers, and cross-repository evidence as substitutes. Record expected, local, confirmed remote, and reviewed SHA separately where applicable.
- An implementation finish notification is an assertion to validate. Verify ownership, committed state, applicable checks, and the exact remote PR head before accepting a published handoff. Persist any authorized follow-up intent atomically with acceptance.
- Review findings bind to the exact reviewed SHA. A changed head makes their current-readiness claim stale; it does not erase the historical result or silently retarget a pending review.
- Distinguish agent assertions from provider-confirmed facts and record observation time/source. Missing checks remain unknown/pending unless explicit project policy permits no CI.
- Store large logs/reports outside checkouts and database rows. Use owned artifact IDs/relative references that cannot escape the run directory. Validate size/path/ownership and retain reports independently of worktree lifetime. Do not let a worker submit arbitrary host file paths for publication.
- Persist validated reports and durable events before acknowledging receipt. Use monotonic event IDs/cursors so reconnecting orchestrators can recover results without live prompt delivery.
- Keep credentials, raw environment dumps, private configuration, and uncontrolled provider exception text out of reports and published evidence. Publish only the permitted result subset using stable markers; reconcile uncertainty before repeating remote writes.

### Required later verification

The state/service/handoff issues must exercise duplicate commands, interrupted effects, unknown launch outcomes, stale SHA changes, invalid worker bindings, CI deadlines and missing checks, suspension/resume, and independent cleanup. Resource release requires verified shutdown; age, an idle agent, or a process exit alone is not proof of safe cleanup.
