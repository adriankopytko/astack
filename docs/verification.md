# Executed implementation verification

`verification run` executes the host-approved baseline and explicitly selected lane/additional checks through lifecycle hooks. It never publishes. A new implementation push or PR publication requires a fresh passed record referenced by `handoff finish`. Worker proposals, a JSON passed claim and host-attestation check lists cannot authorize these new writes. Accepted historical handoffs and already-claimed effect reconciliation retain their existing contracts. See ADR 0025.

## Configure before accepting work

Private host execution policy defines verification per role. The immutable accepted job snapshot retains approved baseline/lane names, definition/command digests and maximum age; it contains no command argv or environment values. Old policies/snapshots without verification retain their old bytes, but do not grant this capability. Configure it before accepting an implementation; a missing or changed approval is not retroactively adopted by an existing job.

Example excerpt from an existing complete host policy:

```json
{
  "execution": {
    "verification": {
      "implementer": {
        "baseline": ["project-check"],
        "checks": {
          "project-check": {
            "command": "check",
            "timeoutMs": 120000,
            "environment": ["PATH"],
            "resources": {}
          },
          "database-check": {
            "command": "check-database",
            "timeoutMs": 120000,
            "environment": ["PATH"],
            "resources": { "APP_PORT": { "key": "api", "field": "port" } }
          }
        },
        "lanes": { "integration": ["database-check"] },
        "maxAgeMs": 3600000
      }
    },
    "commands": {
      "check": { "executable": "/trusted/bin/pnpm", "args": ["run", "check"] },
      "check-database": { "executable": "/trusted/bin/pnpm", "args": ["run", "check:database"] }
    }
  }
}
```

These are placeholders for actual authored project scripts, not commands Astack invents or installs. Existing execution enablement, allowed-environment names, trusted executable checks and maximum timeout still apply. Up to eight approved checks and sixteen lanes are supported; each selection runs at most eight checks. Baseline checks always run first. A selected lane appends its checks, then explicit `additional` approved check names append theirs; duplicates run once, retaining baseline precedence. Unknown names/lanes or missing policy block before execution. `maxAgeMs` must explicitly be 1 second–24 hours. Choose a useful budget for the time between checks and publication.

Portable proposals and worker task text cannot add execution definitions or remove the approved baseline. Hook requests have an optional `verificationCheck` selector usable only in phase `verify`; that selects one named check from the accepted role's current private verification policy. Ordinary setup/verify/start/teardown requests retain their prior behavior. New optional snapshot/request fields are omitted when unused, preserving historical prompt/configuration bytes.

## Run and inspect

```sh
astack verification run --file /absolute/verification.json --json
astack verification inspect <verification-id> --json
astack verification reconcile --file /absolute/reconciliation.json --json
```

Example version 1 run request:

```json
{
  "schemaVersion": 1,
  "jobId": "implementation-job-id",
  "reportId": "accepted-report-id",
  "key": "verify-completed-head",
  "lane": null,
  "additional": [],
  "allocations": [],
  "writersExcluded": true
}
```

`lane` defaults to null; additional checks and allocation references default to empty. If selected checks declare resource inputs, provide precisely their union as `{id,expectedRevision}` references belonging to the implementation attempt. Each hook receives only its declared subset. Values come from explicit owned reservations; secrets remain in the injected host environment reader. No command text, argv, cwd, environment values, max-age override or passed outcome can enter this request.

The target is the exact accepted completed implementation report, acknowledged original input and ready owned checkout, clean on the completed full SHA and assigned branch. The host must stop/exclude competing controllers, checkout writers, native agents and their descendants as appropriate throughout execution and drain. `writersExcluded` is a truthful host attestation, not evidence derived from worker assertions or UI status. CLI mutations acquire coordinator ownership before writable open/migration and refuse an active service. SIGINT/SIGTERM abort and drain the runner before releasing ownership. Inspect is read-only and creates nothing. Imports and service startup do not run checks.

Checks use the existing hook runner's literal argument arrays, canonical cwd, explicit approved environment, deadline, zero-byte output capture and conservative process/group evidence. They execute host-authorized project code with the runner's host permissions; this is not a sandbox or a guarantee that a configured command meaningfully tests the project. No command is retried automatically. Dynamic host environment values are not retained or fingerprinted; hosts must coordinate material input changes and request new verification when those inputs change.

## Durable evidence and source rechecks

Migration 18 stores one immutable attempt/report-bound verification intent per job/key, with a nonexpiring execution claim, revision and local events. Records contain project/repository/checkout/worktree/attempt/branch/base/full-head/input-digest provenance, directory identity, accepted-report fingerprint, approved plan/command/configuration digests and accepted artifact references. Per-check states distinguish `not_run`, `passed`, `failed`, `cancelled` and `unknown`, with exact hook ID/key/revision and sanitized process-result digest. Hook journals retain bounded process evidence; output text, command argv and environment values are not copied into verification records.

Before each effect, intent and an unknown active-check reference are persisted. Only the controller that created/claimed this intent executes its hooks. A crash before or after hook delivery leaves that reference and all remaining `not_run` checks intact. Repeating a prepared/running/terminal key only returns saved evidence; it never resumes commands. Changed request bytes conflict. A different deliberate run requires a new key after inspecting and resolving original writers/uncertain hook holds. Reserved child-hook keys must not pre-exist a new aggregate; each check must be newly completed within that run. Old successful hook receipts cannot refresh verification age.

Nonzero exit, cancellation, timeout, unknown execution or missing proof blocks publication and stops subsequent checks. Even when all commands pass, fresh Git/owned-checkout and artifact inspection must still match the original accepted report, full SHA, branch and clean tracked/untracked state. Artifact digests, sizes, paths and directory identity are rechecked. Dirty/generated tracked or untracked files, changed HEAD, edited accepted artifacts or policy drift prevent aggregate `passed`. The accepted worker report is never rewritten. Existing accepted artifact references are retained and revalidated; this feature does not automatically capture new raw logs or publish artifacts.

A passed record receives authoritative store-clock completion/expiry times after final validation. It remains historical data after expiry or later changes; reads do not mutate it into a different result or rerun it. Hook cleanup reconciliation may advance a hook revision while preserving its immutable successful process result; this does not erase the executed fact. Fresh policy/source/artifact/age checks still govern new publication.

## Publication gate and reuse

After a passed run, reference its exact ID in the ordinary handoff JSON:

```json
{
  "verification": { "source": "executed", "id": "verification-example" }
}
```

This is an excerpt; all destination, report and publication authorization fields remain explicit. `handoff finish` never starts verification implicitly. Before preparing a new handoff and before each never-claimed push/PR stage, it requires the matching report/source, current approved private policy and matching repository proposal, complete approved baseline/lane selection, real successful hook evidence and unexpired completion. Existing handoff source checks bracket artifact validation and require the same clean owned commit. SQLite claim transactions independently validate the saved approved plan and hook evidence at the host clock, preventing a manually recorded passed flag or omitted baseline from becoming a claim.

Changed SHA, branch, filesystem identity, accepted report/input/artifacts, policy/command digests or expiry invalidate permission for new effects. An expired proof between push and PR blocks the new PR even if the push is confirmed. The push is preserved; there is no automatic repeat. To proceed, execute a deliberately new verification intent and, where needed, a new handoff key with the existing explicit safe `replaces` relation. Do not alter a saved handoff's verification reference or bypass an uncertain effect with a new key.

An already-claimed stage is only inspected/reconciled using its original identity and evidence; it does not send another write or rerun checks because proof aged. Read-only reconciliation cannot start an unclaimed next stage. Already accepted handoffs remain historical reads, including legacy host-attestation records, without requiring the checkout/providers/current policy to remain available. Legacy unclaimed stages cannot gain new write authority from old attestations. Generic host publication capabilities outside the implementation handoff workflow retain their separate explicit contracts.

## Cancellation, uncertainty and reconciliation

Cancellation before intent has no effects. Cancellation afterward preserves saved checks, partial execution and hook cleanup holds; unknown is never passed. An uncertain transaction must be reopened and inspected using its stable key/ID. The same run request is an inspection on retry, never command replay. A terminal failed/cancelled/unknown run cannot be overwritten as passed.

If an aggregate remains `prepared` or `running` after controller loss, explicitly exclude the original verification controller and handle any hook writer first. Reconcile with `{schemaVersion,id,expectedRevision,key,writersStopped:true}`. Every referenced executing hook must have its own explicit writer-exclusion or shutdown receipt first. The operation invokes no commands: a prepared aggregate becomes cancelled; an interrupted running aggregate remains unknown. It frees only the aggregate claim, never hook/allocator resources, and preserves accepted outcomes and individual evidence. Exact retries reuse that reconciliation. Use the existing hook/allocator shutdown contracts for services, then native worker reconciliation/worktree cleanup separately.

## Verification

Isolated tests exercise two synthetic technology profiles, baseline/lane/additional selection, false worker/host passed claims, missing policy, mandatory-baseline omission, real command success/failure, cancelled/uncertain execution, dirty or changed HEAD, tracked/untracked files, ignored-artifact mutation, policy drift, expiry between publication stages, direct stale-claim rejection, accepted historical legacy retries, and neutral-directory compiled CLI inspection/reuse. Existing handoff interruption/reopen/migration tests use executed evidence. Default checks make no GitHub writes or real user-agent launches.
