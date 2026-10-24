# Durable local service

## Implemented scope

Astack can run one foreground coordinator per private local state directory. It owns a durable queue and dispatches through explicitly injected runtime adapters. The installed CLI supplies no runtime by default; `service run --codex-herdr` explicitly enables interactive Codex execution through Herdr. Project hooks remain separate work; implementation task delivery is a workflow consumer documented below. A configured executable alone never installs or authorizes a runtime adapter.

Library hosts use `startLocalService(request, { runtimes? })`. The CLI and socket transport share application operations; the dispatcher contains no CLI parsing, socket objects, or ambient project selection. `createServiceCoordinator` is the injected application mechanism; a real host must hold coordinator ownership throughout its lifetime.

## Commands

```sh
astack --state-directory /absolute/private/state service run --capacity 2 --role-capacity 1
astack --state-directory /absolute/private/state service status --json
astack --state-directory /absolute/private/state service wake --json
astack --state-directory /absolute/private/state service submit \
  --project <id> --checkout <id> --role implementer --key <stable-key> \
  --branch <branch> --commit <full-sha> --task '<description>' --json
astack --state-directory /absolute/private/state service inspect <job-id> --json
```

`run` stays in the foreground. SIGINT/SIGTERM stop accepting requests, drain already received submissions and in-flight adapter calls, close state, and release ownership. There is no daemon installer, automatic background spawn, PID-based kill command, worker cancellation command, or OS auto-start. A stopped service does not assert that its previously launched workers stopped.

`status` asks the live coordinator for its session, phase, registered runtimes, limits and queue-state counts. `wake` requests a fresh reconciliation/dispatch pass; it grants no new permissions and does not reset uncertain claims. `inspect` reads a durable job directly from existing compatible SQLite state, including when the service is offline, and contacts no provider. Client read operations do not initialize or migrate state. `run` deliberately opens read-write state and applies migrations.

`submit` requires an explicit registered project and expected branch/full SHA, with optional explicit checkout and no cwd inference. Without `--checkout`, the explicitly selected project's primary checkout is used. It does not create a worktree; orchestration should prepare/register the intended isolated checkout first. Runtime integrations must verify their own ownership/execution preconditions before writes. `--task` must contain no credentials. Requests, policy snapshots and task descriptions are persisted and visible to authorized local clients.

The service command group is a generic dispatch foundation. Implementation/review-specific delegation, worktree preparation, prompts, provisioning and report acceptance remain subsequent operations.

## Local transport and caller authority

ADR 0006 selects a private Unix-domain socket, `service.sock`, under canonical host state. There is no HTTP listener, TCP port or Hono dependency. Multiple projects use one state directory/coordinator; deliberate separate state directories have separate ownership and limits. This does not allocate project application ports or replace the future shared resource allocator.

The enclosing state directory must be private and owned by the host user, the socket is mode 0600, and the endpoint record is a private regular file. Filesystem access is the minimal local caller authority: any same-user process able to access the private endpoint can submit work for registered projects under existing host policy and inspect their tasks. There is no role-scoped authentication or worker credential endpoint. Workers needing narrower authority must not receive access to this control socket; future report credentials will have a separate contract. Local transports do not protect against another hostile process with the same host-user privileges.

Wire protocol: one bounded UTF-8 JSON request followed by newline, one JSON response followed by newline, then close. Requests have `schemaVersion: 1` and `operation: status | wake | inspect | submit | implement_submit | implement_inspect`. Submit fields follow `serviceSubmitRequestSchema`; inspect uses `jobId`. Requests are limited to 64 KiB, client responses to 256 KiB, connections to 32, and incomplete/client waits to 30 seconds. Malformed/oversized inputs return fixed errors or close before acceptance. No arbitrary method dispatch, executable invocation, request-body logging or environment dumps occur in the transport.

A fully received request is independent of the client connection: disconnecting does not revoke accepted intent or cancel dispatch. A lost acknowledgement means the client must inspect/retry with the **same key**, not submit a replacement under a new key. A timeout is not proof that nothing was accepted.

Unix socket paths are limited to 100 UTF-8 bytes for portability across supported Linux/macOS hosts. Select a short private `--state-directory` if needed. Environments that prohibit socket binding need appropriate host permission; Astack does not fall back to public/TCP transport.

## Ownership and endpoint recovery

`acquireCoordinatorOwnership(stateDirectory)` holds an exclusive SQLite transaction/connection on the separate private `coordinator.sqlite` file. This kernel-backed local lock is independent of ordinary short job transactions. Another coordinator fails with `service_already_running`; it never steals a lease based on age, PID absence or claim expiry. Process exit releases the lock. Use local filesystems with working SQLite/Unix socket semantics; network/distributed state is unsupported.

The host holds ownership while inspecting prior effects, serving requests, dispatching, draining adapter calls and closing the transport. It never releases ownership while an earlier asynchronous launch call remains live. Runtime adapters must support bounded work/cancellation; a noncooperating adapter can delay graceful shutdown. A forced host exit leaves durable pending claims for conservative restart inspection, not permission to relaunch.

`service-endpoint.json` binds a session to the socket's device/inode. Only after acquiring coordinator ownership may startup remove a matching stale socket and endpoint record. Unknown files, symlinks, unsafe modes or unmatched ownership are preserved and rejected. A crash between socket binding and endpoint-record publication can leave an unmarked socket; startup then fails closed and requires explicit host inspection rather than deleting it automatically. There is no automatic adoption/repair of uncertain endpoints. Roots and metadata writers must cooperate; these checks do not make arbitrary same-user pathname races atomic.

## Atomic submission and immutable assignment

`submitServiceJob(request, dependencies, signal?)` validates a versioned request and resolves host-approved configuration using explicit project/checkout identities. Only a ready policy permits persistence. It creates one job, its first numbered attempt, one pending worker-launch effect and its queue entry in **one SQLite transaction**, using migration 4. No provider runs inside a transaction.

The saved assignment includes project/repository/checkout, role, exact branch and full SHA, task, policy revision/digests/provenance/skills, job/attempt/effect IDs and scoped idempotency key. Request overrides are saved with the policy snapshot. Project/provider specifics remain outside the generic store and dispatcher.

A retry with the same host requester/project/role/key and equivalent task/assignment/policy returns the original job and current queue evidence. Generated IDs/times from a retry do not create another attempt. Changed task, branch, commit or policy under the same key returns a conflict. Legacy low-level jobs without service entries are not silently adopted. Submission claims durable intent, not worker start or domain completion.

Queue inspection uses bounded pages ordered by acceptance timestamp with job ID as the deterministic tie-breaker. A job delayed by role capacity does not prevent eligible jobs in other roles from progressing. The initial service creates no replacement attempts and never automatically retries a launch, including a verified refusal.

## States and capacity

| State             | Evidence                                                                         | Active capacity                               |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `queued`          | Job/attempt/pending effect committed; no launch claim                            | No                                            |
| `dispatching`     | Launch claim and capacity committed before provider call                         | Yes                                           |
| `started`         | Trusted runtime verifies its worker handle is running                            | Yes                                           |
| `unknown`         | Launch or subsequent worker state is uncertain                                   | Yes                                           |
| `blocked`         | Preflight failed, runtime absent, or launch was definitively refused             | No; uncertain effects cannot enter this state |
| `awaiting_result` | Runtime verifies a known launch is now quiescent, including its writers/children | No; task success remains unestablished        |

The host sets global and per-role capacity; defaults are one globally and one per role. CLI flags set global/default role limits, while library limits can supply individual `perRole` overrides. The claiming transaction counts dispatching, started and unknown jobs across all projects. It also serializes jobs sharing a checkout or repository/branch. An active/unknown writer therefore cannot be bypassed by another role or by claim expiry.

Claims last 10 seconds and bind the attempt/effect to coordinator session and claim token. Expiry is not authorization for takeover or another launch; uncertain jobs retain their slot. Claiming atomically changes the effect claim and entry to dispatching before the provider call. A storage error or uncertain commit stops the coordinator before another effect; reopen/inspect rather than automatically retrying writes.

Before claiming, the dispatcher rechecks the accepted policy, prerequisites, registered checkout identity and exact current branch/SHA. It then invokes only the explicitly injected adapter matching the approved runtime name. The adapter must consume the trusted command definition covered by the accepted policy digest, construct controlled arguments/environment, and recheck its resource/ownership preconditions immediately before writes. The coordinator's read observations do not authorize arbitrary execution or eliminate filesystem/provider races.

## Runtime observations and recovery

`ServiceWorkerRuntime` receives the saved job, attempt, effect, claim and optional recorded handle. Its `start` and `inspect` return validated `WorkerObservation` values:

- `running`: verifies the bound worker exists and supplies a durable handle.
- `quiescent`: verifies that a known bound launch ran and its worker/writers/children stopped; it is **not** implementation/review success.
- `not_started`: verifies the original launch effect did not run and cannot arrive later; a missing PID, handle, resource or response is insufficient.
- `unknown`: cannot establish one of the preceding claims; preserves capacity and any previously recorded handle.

Adapter exceptions and invalid observations become sanitized unknown evidence, never raw diagnostics. Handles are attempt-bound retained worker resources. Known handles cannot be silently replaced. Quiescence records release evidence atomically; unresolved resources and unaccepted task outcomes remain independent.

Every startup/wake pass inspects existing dispatching/started/unknown jobs **before** dispatching unclaimed jobs. Provider evidence can preserve running workers, settle known quiescent launches, or prove a refusal. When an adapter is unavailable or evidence is uncertain, the original claim remains unknown and occupies capacity. A restart never calls `start` for an already claimed job. No inference from service death, idleness, time or process-group absence replaces provider evidence.

Reconciliation is event-driven: startup, submissions, runtime subscription events or explicit `wake` trigger passes. There is no periodic provider polling or GitHub cron loop. Adapters should publish meaningful lifecycle changes and bound their inspection work. Until an adapter supports notifications, callers may explicitly wake after external changes. This foundation has no worker report/CI webhook endpoint yet.

A verified stopped worker becomes `awaiting_result` and can free worker capacity, but its attempt remains unresolved. Report authentication, stale-SHA result validation, terminal domain outcomes, cancellation and cleanup are later operations. Neither runtime exit nor idle agent status establishes a successful implementation/review.

## Results, failures and cancellation

Read operations use completed/rejected envelopes. Submission uses `persisted` with created/existing disposition, rejected, or uncertain. Foreground startup returns a separate `listening` event/handle, which means the endpoint is bound; initial recovery may still be running. Live status reports recovering/running/stopping independently.

Stable service errors are `service_already_running`, `service_unavailable`, `service_endpoint_unsafe`, `service_protocol_error`, and `service_stopping`, plus existing request/configuration/context/state errors. Error messages exclude exception text, raw Git output, command arguments and arbitrary environment values. Request/task authors remain responsible for excluding secrets from persisted input and runtime evidence.

Cancellation before a submission transaction rejects without acceptance. A disconnected client is not cancellation. Once committed, intent remains queued after client or orchestrator exit. Graceful service stop prevents new dispatch, drains active calls, and leaves existing worker records inspectable; it does not relabel acknowledged effects or invent worker cancellation. A hard exit retains whatever committed evidence preceded it. No exactly-once external execution is promised.

## Composition boundaries

`src/host/local-service.ts` is the explicit composition root shared by the CLI foreground command and library hosts. It wires concrete state/Git/filesystem dependencies to application operations and the socket transport. Only `src/cli/service.ts` may import that exact host file; dependency-cruiser rejects other CLI/host edges, and `cli`/`service` still cannot import each other. Core mechanisms, ports and adapters do not import host/transport/application policy.

## Built-in interactive runtime

`service run --codex-herdr [--codex-executable <absolute-path>]` explicitly enables [Herdr-owned interactive Codex](runtime.md). Global `--herdr-executable` selects trusted CLI code. Each saved project/role still requires an enabled unchanged policy, configured Herdr target and owned ready checkout. Launch prepares its grouped layout and starts a session. Generic submissions stop there; explicit implementation jobs additionally deliver their accepted task through the workflow consumer below. Reconnection inspects native identity; UI done/idle and Escape never establish quiescence or release capacity. Without opt-in the built-in runtime list remains empty. Host server trust and unsupported configuration requirements are detailed in the runtime contract.

## Implementation workflow consumer

The [implementation workflow](implementation.md) adds strict `implement_submit` and `implement_inspect` RPC requests and typed implementation receipts. It reuses atomic service acceptance and an indexed scoped key lookup. Runtimes declare supported `workflows`; a missing workflow capability blocks before capacity claim. Optional read-only runtime preflight can block workflow prerequisites before claiming or launching. The Codex/Herdr host composition now decorates its runtime with durable initial implementation input. Generic submissions still start a session without task delivery. RPC contracts live separately in `contracts/service-rpc.ts` to keep workflow packets and generic service records acyclic.

Manual `review_submit`/`review_inspect` RPC operations share this queue and capacity with implementation jobs. Review uses a dedicated owned checkout, targeted GitHub reads and a separate reviewer policy. Workflow preflight rejections retain safe machine-readable error evidence in optional `entry.readiness`; claims clear it. See [manual review](review.md).

Run RPC operations add host report acceptance, responses, explicit continuation, cancellation, event reads/waits and cursor acknowledgements. Cancellation/terminal control is rechecked inside claims and before native effects; active workers are still observed. Socket disconnect and shutdown abort pending bounded waits before draining. See [run operations](runs.md); reports do not release runtime capacity without quiescence.

## Optional CI observer

`service run --observe-ci` enables the separate [CI observation scheduler](ci.md). It consumes only explicitly enrolled persisted review sources, shares exact PR/SHA reads and host budgets, and schedules saved refreshes/deadlines. It has no worker runtime and does not create or dispatch review jobs. Default startup leaves it disabled; existing `service wake` and fresh review dispatch gates remain separate. Service shutdown aborts/drains observer reads together with the coordinator before closing state and releasing ownership. Bootstrap prepares the private state directory, then takes coordinator ownership before writable database opening/migration.

## After-handoff executor

`service run --observe-ci --after-handoff-review` enables [explicit follow-up dispatch](automatic-review.md), independent of the worker runtime flag. Project controls default to disabled and checkout binding is explicit. CI progress wakes the dispatcher; queue readiness and capacity remain fresh. Starting without the executor suspends eligible saved plans before coordinator startup. Shutdown drains both schedulers before state/ownership release. Running/claimed jobs use explicit run cancellation, never an implicit automation-stop signal.
