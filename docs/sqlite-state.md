# SQLite state

## Scope

Issue #10 implements typed local persistence through `node:sqlite`. Its low-level methods do not implement coordination or provider execution. Separate operations now consume it for registration, configuration, worktrees and [durable service dispatch](service.md); interactive runtime launch has its own contract; report authentication remains later work. The state adapter receives trusted host decisions; a stored assertion is not verified provider evidence or permission to remove a resource.

`openSqliteState(request, { now? }?)` explicitly opens a connection. Imports open no database. The returned `StateStore` implements the state port and the existing `ProjectContextReader`, so `resolveProjectContext(request, store)` can consume saved projections today. The returned `registry` shares that connection and serves [project registration/context operations](projects.md); close both through `store.close()`. The returned `worktrees` port shares that connection and persists [owned worktree lifecycle](worktrees.md).

```ts
const opened = await openSqliteState({ schemaVersion: 1 });

if (opened.outcome === 'opened') {
  try {
    // Call state application operations with this store.
  } finally {
    opened.store.close();
  }
}
```

Pass `{ schemaVersion: 1, stateDirectory: '/isolated/state', busyTimeoutMs: 100 }` to select isolated state. Optional `mode: 'read-only'` opens existing compatible state without bootstrap or migrations; absent state returns `state_not_found`, incompatible history requires an explicit read-write open, and write methods reject with `state_read_only`. Read-only SQLite may access/create WAL shared-memory sidecars. Project and service CLI commands consume state; there is no unrestricted state mutation command.

## Directory and lifetime

Linux and macOS are supported. The default is `~/.local/state/astack`, resolved from the host home directory at explicit open time. No project or environment schema is inferred. An absolute `stateDirectory` override is supported; relative paths are rejected.

- Canonicalize explicit root aliases and create missing directories privately. Reject state inside a directory with a `.git` ancestor or a recognizable bare-repository ancestor. This is a filesystem placement guard, not general Git discovery; callers must also keep state outside unversioned source directories and unconventional repository layouts.
- Require a private directory owned by the current OS user. Existing broad permissions are refused, never silently changed. Parent directories must be trusted; this is not protection against adversarial parent replacement.
- Initialize only an empty unowned directory. Preserve unknown contents and reject collisions. An exclusive, private `.astack-state.json` marker identifies the layout; missing/corrupt/incomplete markers are not adopted or repaired automatically. A marker is not host authorization.
- Use a fixed `state.sqlite` file and SQLite's WAL/SHM/journal sidecars. Reject symlinks, hard links, nonregular files, nonprivate modes, and foreign ownership for these files. Missing database files with leftover sidecars are refused. New database files are created exclusively with mode 0600 before SQLite opens them; the directory is mode 0700.
- Check directory identity and file policy before and after opening. The connection assumes its trusted private directory remains controlled for its lifetime. Node's path-based SQLite open is not a portable inode compare-and-swap or an adversarial filesystem sandbox.

`close()` is explicit and idempotent. Closed or poisoned connections reject subsequent operations. No import-time global connection or implicit connection pool exists. Bootstrap failures can leave private files/markers for inspection; they are not deleted automatically. SQLite's durability settings do not make filesystem bootstrap a whole-directory transaction or promise survival on faulty storage.

## Settings and migrations

Connections use foreign keys, WAL journal mode, FULL synchronous durability, NORMAL locking, in-memory temporary storage, a 1000-page automatic WAL checkpoint threshold, disabled trusted schema, disabled double-quoted string literals, and disabled extension loading. The adapter verifies foreign keys, journal mode and synchronous mode. Busy timeout defaults to 100 ms and is configurable from 0 to 1000 ms. SQLite calls and lock waits are synchronous; these bounds are not a hard real-time deadline for filesystem or storage faults.

Migrations are numbered immutable SQL constants in `src/adapters/state/migrations.ts`, compiled into `dist/adapters/state/migrations.js` and included through the existing `dist` package allowlist. They do not depend on cwd or ignored planning files. Migration 3 adds the worktree intent/lifecycle ledger with project/key, repository/branch, and path uniqueness. Migration 2 adds deliberate project/checkout registrations with filesystem identity observations; existing projection rows are not automatically adopted. Add a new migration for changes to a released schema; do not edit an applied migration.

The adapter checks `application_id`, `user_version`, ordered migration numbers and SQL checksums. Unknown/newer/modified history or an unrelated database is refused. Recheck history after acquiring `BEGIN IMMEDIATE` so competing opens cannot apply the same migration twice. Migration SQL, ledger entries, and version/application markers commit transactionally. No automatic downgrade, destructive reset, or repair is provided. Schema checksums detect migration-history mismatches; they are not a tamper-proof database signature or a full corruption scan.

All variable record values use prepared statements and bound parameters. The only generated SQL contains adapter-owned migration/version constants. Foreign keys and unique indexes enforce local identities, idempotency scopes, attempt lineage, claims, and resource retention. The adapter does not expose a public SQL connection or transaction callback.

## Application operations

Every operation accepts an unknown versioned request plus the injected `StateStore` and an optional `AbortSignal`. Validation precedes cancellation. These are synchronous local operations; cancellation is checked before executing a transaction, with no interrupt or cancellation claim after a committed write.

| Operation              | Input beyond `schemaVersion: 1`                           | Stored evidence and behavior                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveStateProject`     | `repository`, `project`, `checkout`                       | Atomically store a consistent repository/project/primary-checkout bundle. Repetition preserves identical records; identity/path collisions reject. No Git discovery, path canonicalization, trust/adoption policy, or additional checkout registration is performed here. |
| `acceptStateJob`       | `job`                                                     | Persist immutable identity, requester, operation, idempotency key, creation time, and bounded intent. Return the original job for an equivalent scoped retry. No worker is queued or started by this call.                                                                |
| `prepareStateAttempt`  | `attempt`, `effects`                                      | Atomically persist the next numbered attempt, full commit/branch assignment, and 1–16 pending effect intents before any provider execution. Only one unresolved attempt per job is allowed.                                                                               |
| `claimStateEffect`     | `effectId`, `owner`, `token`, optional `leaseMs`          | Persist one short claim for a pending effect. An identical live claim retry returns the original claim without extending it.                                                                                                                                              |
| `resolveStateEffect`   | `effectId`, matching `owner`/`token`, `state`, `evidence` | Record `confirmed`, `unknown`, or `cancelled` observation. `unknown` may later become confirmed/cancelled with the same binding and fresh evidence. Confirmed/cancelled evidence is immutable except for an identical retry.                                              |
| `recordStateResult`    | `result`                                                  | Store one terminal `completed`/`failed`/`cancelled` local result per attempt and resolve that attempt in the same transaction. Pending/unknown effects block this operation. It does not authenticate a worker, validate verification claims, or release resources.       |
| `retainStateResource`  | `resource`                                                | Retain an attempt-bound provider handle with a globally unique active `(kind, key)`. Historical released records remain stored.                                                                                                                                           |
| `releaseStateResource` | `resourceId`, recorded `attemptId`, `evidence`            | Record release evidence/time; matching repeated evidence returns the existing record. No OS socket/service/worktree operation is performed.                                                                                                                               |
| `inspectStateRecord`   | `entity`, `id`                                            | Read a `job`, `attempt`, `effect`, `result`, or `resource`; missing records return null. Attempt observations also include `resolvedAt`.                                                                                                                                  |

Storage formats are defined by `src/contracts/state.ts`; corresponding request schemas and record schemas are public exports. ID tokens are bounded ASCII identities, not authentication secrets. Branch and commit assignments are observations that future runtime operations must verify against the target checkout immediately before use. The repository's SHA-1/SHA-256 format constrains attempt commit length.

Job idempotency is scoped by `(requester, projectId, operation, idempotencyKey)`. Canonical object-key ordering makes equivalent JSON intents equal. The semantic comparison includes project/repository/checkout, requester, operation, key, intent, and the optional configuration snapshot; a retried caller may propose a new job ID/time and still receive the original receipt. Changed intent or policy snapshot under the same key rejects. Jobs without a snapshot keep their existing hash. [Configured job acceptance](configuration.md#job-acceptance-and-dispatch-gate) saves policy revision, provenance and skill pins in the same job transaction; legacy low-level jobs cannot pass the dispatch configuration gate. The optional JSON field needs no new SQL migration. Other record writes require stable IDs and equivalent content for an idempotent retry. No mutable upsert silently reassigns ownership or changes the original intent.

Attempt numbers are sequential per job. Preparation retries return current stored effect observations without claiming execution. A terminal result permits another explicitly prepared attempt; an unknown effect or unresolved attempt never silently permits another worker.

Resources outlive terminal results. The `(kind, key)` uniqueness constraint spans projects, but a shared allocator must still normalize keys and perform provider checks. A database port reservation does not reserve a socket. Only trusted application code that has freshly verified provider shutdown/removal should record release; an attempt ID or caller-supplied evidence is not enough to authorize cleanup.

Migration 4 adds service queue entries. Service submission atomically saves configured job, first attempt, pending launch effect and queue entry; capacity claiming and runtime observations remain bounded transactions. A separate private `coordinator.sqlite` lock file provides lifetime leadership without holding the job database open in a write transaction. Its release on process exit does not prove worker shutdown. See [the service contract](service.md).

Migration 5 adds explicit Herdr project targets and primary/worker space reservations. Compare-and-set pending intent precedes provider writes; ready worker layout and agent resources are persisted with their attempt bindings. The primary association is project-scoped and is not released by worker lifecycle. See [Herdr integration](herdr.md).

## Claims and external effects

Claims default to 10 seconds, with a configurable maximum of 30 seconds. A caller supplies stable owner and token IDs; an injected trusted wall clock supplies timestamps. Claim tokens are nonsecret fencing identifiers, not capabilities authenticating a worker. Tokens cannot be reused for another effect.

A live claim cannot be replaced by another claimant. Expiry, a clock moving behind claim creation, and an unknown effect return `state_reconciliation_required`. The adapter never steals an expired claim, clears it by age, relaunches an effect, or promises exactly-once execution. No general claim-renewal/reassignment operation is exposed yet.

An expired original binding can still record verified outcome evidence through `resolveStateEffect`. Expiry does not establish whether the original provider call ran. A future coordinator must establish writer quiescence and inspect provider evidence before deciding how to settle uncertainty; this adapter does not do that reconciliation. The current conservative behavior can leave work blocked until that operation exists.

Commit accepted intent and pending effects before running any provider call. Provider calls happen after the storage method returns. Record provider handles/outcomes promptly using the same attempt/effect binding. Connection/transaction locking is independent of service leadership, role capacity, worker authorization, and OS resource ownership; those policies belong to their consuming operations.

## Results, failures and retention

A write returns one of:

```ts
type StateWriteResult<T> =
  | {
      schemaVersion: 1;
      outcome: 'persisted';
      disposition: 'created' | 'existing' | 'updated';
      value: T;
    }
  | { schemaVersion: 1; outcome: 'rejected'; error: { code: OperationErrorCode; message: string } }
  | {
      schemaVersion: 1;
      outcome: 'uncertain';
      error: { code: 'state_write_uncertain'; message: string };
    };
```

`persisted` means the local transaction committed or equivalent durable data already exists. It is not an accepted service job, a running worker, or domain completion. `createStateWriteResultSchema(valueSchema)` validates decoded write results. Reads use the existing completed/rejected envelope. Open returns `opened` with a live store or a rejection; that runtime object is not a JSON receipt.

Transactions are short `BEGIN IMMEDIATE` blocks, with no awaited provider calls or user transaction callbacks. A validation failure invokes no store. Constraint/conflict errors roll back; bounded lock contention returns `state_busy`. There are no automatic retries. A successful rollback after a known pre-commit failure leaves the connection usable.

An uncertain commit acknowledgement or failed rollback returns `uncertain` and poisons the connection. Reopen and inspect the supplied stable record IDs/idempotency keys before retrying storage, and inspect provider evidence before repeating external effects. Do not assume a rejected transport response means a transaction or provider effect did not happen. A migration/open failure returns no live store; inspect the directory/history before retrying and preserve interruption evidence.

Stable state error codes include `state_busy`, `state_conflict`, `state_not_found`, `state_reconciliation_required`, `state_invalid_data`, `state_schema_mismatch`, `state_directory_unsafe`, `state_unavailable`, and `state_closed`. Public errors contain fixed messages rather than SQL text, payloads, credentials, paths, or original exception diagnostics.

Intent, effect payloads, evidence, and resource handles are JSON objects limited to 16 KiB each, nesting depth 16 and 1024 visited values. Retain large logs/reports as private artifacts outside the database and checkouts, and store only permitted owned artifact references. These limits do not automatically redact secrets or validate report provenance. Callers must exclude credentials, environment dumps, raw provider errors, and arbitrary publishable host paths. This issue adds no result/event subscription, broad job listing, retention deletion, or worker report protocol.

## Verification and references

Disposable databases exercise migrations and reopen, equivalent/conflicting writes across connections, atomic rollback, competing/expired claims, unknown-effect preservation, terminal results and independent resources, bounded contention, abrupt process exit during a transaction, malformed/unsupported history, private directory policy, compiled migration availability, and lost commit acknowledgement. No production state, live agents, user projects, or remote providers are used.

See [Node 24 SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html), [SQLite transaction behavior](https://sqlite.org/lang_transaction.html), and [SQLite pragmas](https://sqlite.org/pragma.html) for the underlying synchronous API, transaction, and durability semantics.

## Interactive runtime records

Migration 6 adds one runtime session per saved service attempt, unique launch/effect/space bindings, and keyed digest-only action history with a unique pending action per attempt. Session/resource intent is atomic before launch; actions reserve before input/interrupt. Uncertain acknowledgements preserve pending intent. See [the runtime contract](runtime.md) and ADR 0008 for provider identity, server trust and recovery limits.

## Implementation acceptance

Implementation jobs reuse existing job/configuration/attempt/effect records and runtime action receipts; no migration is added. Versioned task packets contain selected context, owned-checkout identity, instruction path/digest references and result contract version. The service store provides a read-only scoped idempotency lookup, and the worktree store provides a checkout lookup for the consuming ownership gate. See [implementation delegation](implementation.md).

Migration 7 adds transactional manual-review request aliases and a target lookup index. Aliases preserve each normalized request key while same-target requests reuse one unresolved review. See [manual review](review.md). Existing migrations remain unchanged.

Migration 8 adds run control, report/response/continuation/cancellation records, monotonic events and scoped consumer cursors. Queue/run changes append events in their write transaction; existing service entries get baseline observations without provider effects. Existing generic terminal results block new dispatch and remain distinguishable from validated report records. See [run operations](runs.md).

## Runtime input retry journal (migration 9)

`runtime_input_retries` preserves explicit host-attested authorization keyed by attempt/input key/generation, including digest, launch binding and timestamp. Authorization and removal of the exact active pending input are one transaction. Recreated same-key actions use the next generation and must retain the original input digest/kind. Older action JSON defaults to generation zero. Full-action comparisons reject delayed acknowledgements. The journal neither proves non-delivery nor authorizes a provider write itself; see [runtime recovery](runtime.md#explicit-recovery-after-proven-input-refusal).

## Implementation handoff journal

Migration 11 adds `implementation_handoffs`, exposed through `openSqliteState().handoffs`. A unique current record per source implementation job binds a keyed publication request and completed report to a separate host publication job/attempt and push/PR effects. Preparation, safe predecessor replacement, and acceptance plus optional requested review/events are each atomic local transactions. No external process runs inside those transactions. See [the handoff contract](handoff.md) for replay, uncertainty, explicit writer exclusion and read-only listing limits.

## CI request and observation state

Migration 12 adds source-bound `ci_requests`, shared full-target `ci_targets` and per-host `ci_budgets`, exposed through `openSqliteState().ci`. Request controls and observation settlement append run events in the same transactions. Read claims reserve conservative API-slot costs before provider calls; schedules, participant revisions, leases, deadlines and cooldowns survive restart. Expired read claims are replaceable; uncertain write effects remain governed by their separate contracts. Writable local-service startup acquires coordinator ownership before opening/migrating the main database. See [CI observation](ci.md).

## Automatic review controls and plans

Migration 13 adds `review_automation` and `review_follow_ups`, exposed through `openSqliteState().automaticReviews`. Settings disablement and owned-wait suspension are atomic; queue acceptance/linking and worker claim/plan dispatch are also atomic. Control revisions and fresh CI generations prevent implicit backlog resume. Shared adapter transaction helpers preserve state-layer direction without nested transactions or importing application policy. See [after-handoff review](automatic-review.md).

Migration 14 adds report-bound review freshness observations and separate host publication intents. Accepted reports keep their 48,000-byte request limit and a separate 96 KiB total envelope limit including verified evidence; their dedicated reader uses that bound. Ordinary row reads retain the 32,768-character limit, and generic intent/effect/resource metadata retains its 16 KiB limit. Review publication intent, host job/attempt/effect and its source event are accepted transactionally; no provider executes inside a transaction. See [review results](review-results.md).

Successful handoff/review publication now records the separate host attempt's terminal result using the ordinary bounded result transaction, with a `publication_finalized` source-run event. All expected effects must be confirmed and their domain receipts/bindings verified. This requires no schema migration. Explicit writer-excluded finish/reconciliation repairs already accepted/confirmed records missing this local result; reads and startup never repair them automatically. An unknown effect or conflicting result preserves the unresolved attempt and cleanup blocker.

## Shared host allocations

Migration 16 adds `resource_allocations`, exposed through `openSqliteState().allocations`. Short transactions claim globally normalized protocol/port or namespaced name keys, bind accepted source assignments, create cleanup holds, and append events atomically. Socket probing happens outside transactions. Startup receipts and retained claims never expire by age. A release guard prevents generic resource APIs from freeing an active allocator hold; exact shutdown-verified allocation release settles both records together. See [resource allocation](resources.md) for host attestations, retry and cancellation requirements.
