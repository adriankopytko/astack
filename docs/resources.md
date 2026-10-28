# Shared host resource allocation

`resources` manages cooperating port and name reservations in the selected shared host state database. It does not launch/stop services, install software, change environment files or grant execution policy. Explicit [project hooks](hooks.md) consume these operations separately. Use one state directory for all projects sharing a host; separate databases are separate allocation domains, not distributed coordination. See ADR 0023.

## Requests and binding

`reserveAllocation` accepts a version 1 request with saved `jobId`, exact `attemptId`, stable `key` and one resource specification. The transaction verifies the accepted service assignment and captures project, repository, checkout, branch and full SHA. No ambient directory or pane selects the target. This is saved assignment evidence, not a fresh filesystem/Git observation; actual execution must separately recheck the assigned checkout and current trusted policy. New reservations/startup require an active, unresolved implementation attempt. Static review never provisions services; integration-review allocation requires keys declared by the exact saved review; dispatch remains blocked until explicit hook startup and independent endpoint ownership/readiness verification.

A port specification declares `tcp` or `udp`, numeric bind policy (`127.0.0.1`, `0.0.0.0`, `::1` or `::`), and an ordered, unique list of 1–16 unprivileged candidate ports (1024–65535). A single candidate expresses a fixed-origin constraint: contention blocks rather than changing it. Claims serialize the entire protocol/port across IPv4, IPv6, loopback and wildcard bindings conservatively. TCP and UDP may share a number. There is no implicit broad-network bind default; the host selects the bind policy explicitly.

A name specification selects `service`, `container` or `cache`, a lowercase safe prefix and `fixed`. Dynamic names combine a bounded prefix with a stable allocation-ID suffix derived from attempt/key; fixed names serialize the exact prefix. Name uniqueness is per declared namespace across projects in this database. These are logical claims; the host/provider must check actual external names and ownership before effects. No container/cache/provider API is called.

One allocation is identified deterministically by attempt/key. Changed request bytes conflict under that identity. A released record remains historical; the same key never resurrects it. An intentional new resource needs a new key. The host must not use new keys to bypass uncertain existing startup.

## CLI

Write versioned JSON requests to regular bounded files, then invoke from any directory:

```sh
astack resources reserve --file /absolute/reserve.json --json
astack resources inspect <allocation-id> --json
astack resources list --project <project-id> --limit 50 --json
astack resources start --file /absolute/start.json --json
astack resources running --file /absolute/running.json --json
astack resources retain --file /absolute/retain.json --json
astack resources release --file /absolute/release.json --json
```

Mutations require existing private state and hold coordinator ownership before writable open/migration through completion. They refuse an active coordinator; no resource RPC or automatic background lifecycle is installed. Library operations can be injected into the owning coordinator without a second allocator. Read-only inspect/list create no state and bind no sockets. List uses explicit project filtering and bounded ID cursor pagination (`--after`, `--limit`). CLI emits versioned JSON; non-JSON rendering pretty-prints the same evidence. Errors, unknown writes and blocked/probing records exit nonzero.

Example reserve request:

```json
{
  "schemaVersion": 1,
  "jobId": "job-example",
  "attemptId": "attempt-example",
  "key": "api-port",
  "spec": {
    "kind": "port",
    "protocol": "tcp",
    "host": "127.0.0.1",
    "candidates": [43100, 43101, 43102]
  }
}
```

For a name, replace `spec` with `{ "kind": "name", "namespace": "container", "prefix": "worker", "fixed": false }`. No credentials or arbitrary environment values belong in these records/files.

## Reservation and startup

Migration 16 stores global uniqueness and per-allocation revisions. Every accepted reservation creates an existing-style retained resource hold in the same transaction. Events are appended with mutations. Short `BEGIN IMMEDIATE` transactions contain only local SQL; no socket operations run under a SQLite transaction. These claims have no age-based expiry.

Port reservations are persisted as `probing` before temporary exclusive bind probes. The network adapter closes its temporary sockets; `free`, `busy`, and `unknown` remain distinct. Permission failures, unsupported addresses and other errors are unknown, not free. A bind observation is not an OS reservation. Unmanaged processes may bind immediately afterward.

A free candidate becomes `reserved`. Known busy candidates can advance through the explicit bounded list only while startup has never been granted. Database contention skips already-claimed candidates transactionally. An externally busy final candidate remains `blocked`; unknown evidence preserves that candidate without treating it as available or skipping it. Repeat reserve resumes these read-only probes, not service startup. If no alternative remains, a fixed/final candidate can be reprobed under the same reservation identity and become ready when an unrelated listener stops. Names become reserved without an OS/provider probe.

`startAllocation` takes `{schemaVersion,id,expectedRevision,key,controller}`. It rechecks the port is free, active source assignment and exact revision, then persists `starting` and the keyed controller receipt **before** the host can start anything. A newly persisted `updated` receipt authorizes use of the reserved resource once within separately approved execution. An `existing` receipt is historical evidence, never permission to start again. Uncertain commits require reopen/inspection, never another launch. No process is started by this operation.

A bind race detected before that receipt records blocked evidence; repeat reserve can select a remaining managed candidate. After a startup receipt exists, reserve never reallocates it. A startup crash, failed command or missing acknowledgement remains `starting`; the host must establish shutdown and release explicitly. Settings are returned as structured values for future managed provisioning; authored `.env` files are never rewritten and unrelated listeners are never killed.

`confirmAllocationRunning` requires `{schemaVersion,id,expectedRevision,key,controller,ownedEndpointVerified:true}` selecting the exact startup receipt. Ports must currently be observably bound. The host must independently verify the actual service/provider handle, expected endpoint and application readiness; a busy socket is insufficient, especially for UDP. That affirmative host attestation and verification time are recorded with the binding. The generic allocator cannot authenticate arbitrary service owners. Callers must only provide truthful attestations obtained independently of worker assertions. Names similarly require verified external ownership through the host. No native provider ownership can be inferred from a name or PID.

## Retention, shutdown and release

`retainAllocation` takes `{schemaVersion,id,expectedRevision}` for a running allocation. `retained` keeps every claim/cleanup hold indefinitely; age, task result, cancellation, worker idleness or service restart never release it. Missing or uncertain startup already retains its claim without needing a retention transition.

Release takes:

```json
{
  "schemaVersion": 1,
  "id": "allocation-example",
  "expectedRevision": 3,
  "key": "verified-shutdown",
  "startupKey": "start-api",
  "writersStopped": true,
  "servicesStopped": true
}
```

`startupKey` must match the saved receipt, or be `null` only when startup was never granted. The trusted host must independently verify owned services stopped and stop/exclude original startup controllers, writers and descendants **before** requesting release. For names, host evidence is essential because there is no generic provider query. For ports, the operation additionally requires a fresh free bind observation. A bound/unknown endpoint keeps its reservation even when a host asserts shutdown; this can conservatively retain a port subsequently occupied by an unrelated listener. Do not kill that listener to make release pass.

After probing, a revision compare-and-swap atomically releases the allocation and its matching cleanup hold, appending an event. A concurrent startup/retention transition defeats stale release evidence. Identical completed release retries are historical reads; changed key/revision/receipt evidence conflicts. New reserve then has access to the released endpoint/name. No claim timeout, expiry worker or automatic cleanup is installed.

A SQLite trigger prevents generic resource release, worker shutdown reconciliation or cleanup paths from freeing an active allocator hold. Release allocator resources through this explicit operation first; native worker reconciliation and worktree removal remain separate. Retained resources continue blocking existing worktree cleanup, including resources held by other jobs using that checkout. Runtime absence alone cannot release application services.

## Errors, cancellation and verification

Public inputs validate before mutation. Cancellation before reserve/start/release creates no new intent; abort during probing may retain a probing/blocked claim and stops startup/release. Probe failures are sanitized. `StateWriteResult` preserves rejected versus uncertain commits; reopen and inspect the deterministic ID after uncertainty. Existing `starting` effects never replay. A thrown probe becomes unknown evidence. A failure appending the event rolls back both allocation and hold. Source and revision checks repeat at each transaction, but neither database state nor socket probes establish an atomic host snapshot: the host must coordinate/exclude external controllers.

Isolated tests cover two project connections racing before bind, fixed/wildcard conflicts, protocol separation, generated/fixed names, repeat keys, bounded fallback, unmanaged listeners, unknown evidence, startup receipt reuse, retention, generic-release bypass, exact release/reallocation, stale probe/release races, cancellation and transactional event rollback. Native TCP/UDP checks use disposable loopback sockets. Default checks never launch real agents, containers or user services, mutate GitHub or rewrite project settings.
