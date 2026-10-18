# Interactive Codex runtime

## Implemented scope and execution owner

`codex-herdr` launches, inspects, submits input to, requests interruption of, and reconciles interactive Codex workers. The generic service consumes `ServiceWorkerRuntime`; the Herdr-specific control port is `InteractiveWorkerProvider`. Application operations receive both explicitly. Other technologies and coding agents do not need to adopt this provider's implementation.

**Herdr owns execution.** Its server starts canonical `codex` in an existing verified worker pane and owns the terminal/process lifecycle. Astack owns durable intent and control policy, not a second Codex subprocess, app server, PID supervisor or terminal writer. `--no-daemon` keeps this integration on the interactive process path. Astack never attaches a second process controller, resumes another native session, starts headless execution, closes the worker workspace, or kills the Herdr server.

Starting a generic session does not send the saved task description. The implementation and manual review workflows deliver explicit assignments through durable keyed input. Run operations accept host-supplied reports and expose explicit continuation/cancellation. Pinned skill delivery, provisioning, automatic report collection and cleanup remain later work.

## Host opt-in and prerequisites

Register the project, approve its private host policy, prepare an owned worktree and select its registered checkout explicitly when submitting the job. Configure the project's Herdr target first. Run:

```sh
astack --state-directory /private/astack --herdr-executable /trusted/bin/herdr service run \
  --codex-herdr --codex-executable /trusted/bin/codex
```

Without `--codex-herdr`, the installed service continues with no built-in runtime. Library hosts may explicitly inject `createCodexHerdrRuntime(dependencies)` instead. Enabling it does not authorize all projects: each saved role must select `codex-herdr` and an approved command under an unchanged, enabled host policy. Provider targets still come from that project's saved settings, never the service cwd or ambient Herdr focus.

The approved role command's `executable` must equal the host-selected canonical Codex path. Its native `args` must contain each of these flags exactly once (order may vary):

```json
[
  "--sandbox",
  "workspace-write",
  "--ask-for-approval",
  "on-request",
  "--no-daemon",
  "--no-alt-screen"
]
```

`read-only` is the other supported sandbox; `never` is the other supported approval mode. Other native arguments, initial prompts, resume/remote/profile/config overrides, extra writable directories, model selection, and bypass flags report `runtime_capability_missing`. The adapter appends `--cd <verified-owned-checkout>` itself. Role environment/skill requirements and non-null setup/verify/teardown hooks currently block rather than being ignored. Provisioning those requirements is not implemented here.

**Server trust is explicit.** Herdr protocol 22 starts the canonical executable by kind; it cannot accept an absolute agent executable, an isolated environment, or an atomic expected-native-session guard. The host opt-in attests that each configured local server resolves canonical `codex` to the approved path and that its shell startup, inherited environment, Codex configuration, hooks/plugins, credentials and repository trust are suitable for this worker. The local executable prerequisite check cannot prove server-side PATH resolution or effective native configuration. This adapter is not an isolation boundary from the same host user or a compromised server. Do not enable it for an untrusted server, or treat the argument allowlist as control over all ambient Codex extensions.

`timeoutMs` bounds each runtime provider control call (including its last target guard), not all prerequisite IO, the whole task or agent lifetime. Startup uses at most 30 seconds, with a shorter Herdr readiness timeout inside that bound; other control calls also have a role-bound abort signal and the adapter's shorter bounded process timeout. Supported role control budgets start at five seconds. No process is killed and no capacity is released because a task elapsed. The runtime declares no verified quiescence capability; whole-task deadlines remain unimplemented; explicit run cancellation adds no automatic deadline timer.

Initially supported evidence is Herdr 0.9.0/protocol 22 and installed Codex CLI 0.162.1's interactive flags. Local help/schema inspection established these interfaces; no live agent was started during default verification. Other versions can refuse a command; no update, install, server restart or fallback is attempted.

## Operations and evidence

All public application requests have `schemaVersion: 1`, explicit `attemptId`, strict fields and fixed errors:

| API                                                | Preconditions and effects                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launchRuntime(request, dependencies, signal?)`    | Fresh unresolved saved service attempt with a capacity claim, unchanged role policy, owned ready checkout and exact initial branch/SHA. Prepares/reuses its grouped Herdr layout, reserves the runtime record/resource, then issues at most one launch from that reservation. |
| `inspectRuntime(request, dependencies, signal?)`   | Reads saved intent and fresh project, checkout ownership, branch, Herdr layout, endpoint, pane/terminal, foreground cwd, unique attempt name/kind and any native session ID captured at binding. Makes no provider write or state change.                                     |
| `reconcileRuntime(request, dependencies, signal?)` | Never launches or submits input. A matching detected Codex with its unique attempt name and owned layout can settle a pending launch and retain its agent binding; a native session ID is optional. Missing/changed evidence remains unknown.                                 |
| `inputRuntime({ ...request, key, text }, ...)`     | Ready matching session, unresolved claimed attempt, refreshed policy, idle/done input surface and no pending action. Persists an action digest/key before one prompt submission.                                                                                              |
| `interruptRuntime({ ...request, key }, ...)`       | Same verified assignment/policy and no pending action. Requests Escape once; never sends shell Ctrl+C, closes a pane, kills a process or reports verified cancellation.                                                                                                       |

These APIs return `OperationResult<RuntimeStatus>`. A rejected operation has a fixed machine-readable error; status is `not_started`, `running`, `blocked` or `unknown`. `not_started` means no runtime record exists, not authoritative proof that no external worker exists. Read-only inspect can operate after policy revocation; new control writes cannot. Repeating an already recorded action reads its receipt and current liveness without reauthorizing or resending it.

Capabilities are available as `runtimeCapabilities` and `astack runtime capabilities`. They explicitly report Herdr execution ownership, launch/inspect/input/interrupt/reconcile support, and the absence of headless execution, atomic target guards, turn delivery receipts and verified process quiescence.

Identity includes saved job/attempt/effect, deterministic launch ID, project/repository/checkout/branch/base SHA, canonical filesystem location, explicit session/socket/transport epoch, space and workspace/tab/pane/terminal, unique attempt name and agent kind. Native Codex session IDs are optional supplementary evidence: an ID captured at binding must remain present and unchanged. A binding established without an ID stays based on the name/layout; metadata first appearing later does not upgrade that binding. Later worker commits may change HEAD; the branch and owned checkout must still match. Protocol 22 transport epoch is not a server-issued UUID; retain the limitations in [Herdr identity](herdr.md).

Each control adapter takes another fresh snapshot immediately before mutation and targets input/interrupt by the saved unique agent name, with controlled argv and explicit Herdr endpoint environment. Missing capabilities/providers, wrong pane/terminal/cwd, replaced native session, changed endpoint or unresolved layout prevent control. Snapshot validation and mutation are separate provider calls: another same-user actor can race between them. Herdr does not offer an atomic compare-and-mutate identity guard. One trusted controller per worker and no reuse of Astack-reserved names are host preconditions; no cryptographic worker ownership is claimed. Names are not process-generation tokens: a same-user actor deliberately reclaiming the same name in the same terminal/checkout can defeat name/layout attribution when no native ID was captured. The adapter does not claim to detect such replacement.

## CLI

```sh
astack runtime capabilities
astack runtime inspect --attempt <id> --json
astack runtime reconcile --attempt <id> --json
astack runtime input --attempt <id> --key <stable-action-key> \
  --codex-executable /trusted/bin/codex --json < prompt.txt
astack runtime interrupt --attempt <id> --key <stable-interrupt-key> \
  --codex-executable /trusted/bin/codex --json
```

Launch is performed through the capacity-owning service, not a standalone CLI bypass. Offline runtime commands use the same selected private host state and saved project target. Inspection opens state read-only; reconciliation/control may migrate existing state. `blocked`/`unknown` and rejected results exit 1; capability output needs no state/provider. Input reads lossless UTF-8 stdin up to 16 KiB; tabs/newlines are allowed but other terminal control characters are rejected. No text is echoed or persisted in runtime state: actions contain a SHA-256 digest, kind, key and acknowledgement state. Digests are not encryption and can reveal low-entropy text by guessing. The Herdr CLI necessarily receives prompt text in argv, visible to same-host process inspection; prompts must not contain credentials. Provider stdout/stderr, terminal transcripts and arbitrary metadata are not exposed or retained by these operations.

Blocked approval/question UIs are not answered automatically, including via interrupt. The operator must handle the dialog intentionally. An agent already working does not accept another prompt through this initial runtime; there is no implicit queue or steering fallback.

## Recovery, concurrency and cancellation

SQLite migration 6 adds one session per attempt, one space/effect/launch identity per session, keyed action history and a unique pending action per attempt. Reserve and compare-and-set transactions are short; provider IO happens outside them. The session and retained runtime resource are accepted atomically before launch. An uncertain database acknowledgement requires reopening/inspection, never another provider call. Concurrent local callers cannot both launch from the same reservation or submit the same action. Other writers/providers must obey the same ownership preconditions.

A crash before Herdr launch, after process creation but before its acknowledgement, or before binding all leaves a pending launch. Repeated `start` only inspects it. When a fully matching named worker appears, reconciliation may record its identity even if the original call's response was lost; it does not repeat the effect. Absence, age, expired service claim, a missing PID, an empty pane or a changed endpoint cannot authorize replacement. An absent pending launch remains unresolved; this version has no force reset/replacement operation.

Input/interrupt acknowledgement means Herdr acknowledged writing terminal input; it proves neither a Codex turn started nor any domain outcome. The same key and digest returns the saved receipt; changed bytes/kind under that key conflict. A lost acknowledgement leaves a pending action and blocks subsequent control. Native UI status cannot establish whether that input was delivered, so reconciliation deliberately leaves the action pending. Explicit evidence-based settlement/abandonment and richer turn receipts are later work; do not evade an uncertain write by editing SQLite or switching action keys.

Cancellation before acceptance starts no runtime effect. After acceptance, abort/timeout can stop waiting on the Herdr CLI but cannot revoke an accepted server request or prove that Codex/descendants stopped. Pending intent and capacity remain. Escape requests are separate durable actions, not terminal cancellation results. Service shutdown drains its own calls and leaves Herdr-owned sessions running. Reconnection refreshes saved identity rather than assuming a new launch is necessary.

Liveness and domain results remain separate. Idle, done, blocked, successful prompt delivery and Escape acknowledgement never resolve an attempt, release its resource/capacity, or permit checkout cleanup. The service sees a verified named worker as running even when its UI is idle/done. Missing/replaced sessions yield unknown, not quiescent. No recurring provider/GitHub polling was added; service startup, submission, and explicit `service wake` trigger inspection. A later event integration can wake the same runtime without changing these contracts.

## Verification and sources

Controlled fixtures cover optional/omitted native session IDs, missing/replaced names, changed/lost captured native IDs, name-targeted controls, reconnect without native IDs, concurrent duplicate starts, intent before launch, crash before launch, launch-before-handle loss with reopened-state recovery, wrong pane assignment, replacement native session/terminal/cwd/endpoint, input deduplication and uncertain delivery, approval/busy controls, interrupt requests, revoked policy/unsupported flags, coordinator dispatch/reconnect and neutral-cwd packaged command behavior. No default check starts a real user agent or mutates a live Herdr session. Live-provider verification is a separate explicit opt-in.

Primary references: [Herdr CLI](https://herdr.dev/docs/cli-reference/), [Herdr socket API](https://herdr.dev/docs/socket-api/), and [OpenAI CLI reference](https://developers.openai.com/codex/cli/reference/). Installed `herdr agent start/prompt/send-keys --help`, `herdr api schema --json` and `codex --help` are the compatibility evidence for the current adapter.

## Implementation consumer

[Explicit implementation handoff](implementation.md) now decorates this runtime with deterministic keyed initial input and saved blocker/delivery evidence. Runtime resource handles use immutable runtime/launch/space identity, while native session evidence remains in the separate session binding. Existing compatible saved handles are retained across reconnect rather than rewritten as native identity becomes available.

Run lifecycle controls now gate new native launch/input. Explicit cancellation interrupts can target a verified retained worker after cancellation or terminal report acceptance, while new task input is blocked. Existing keyed receipts remain readable; interrupt acknowledgement still does not prove quiescence. See [run operations](runs.md).

## Explicit recovery after proven input refusal

`runtime authorize-input-retry` records a trusted host authorization for one exact pending input generation. Stop the coordinator and all original controllers first. Independently establish that the original input was never submitted and no caller/descendant can deliver it later. This is a host attestation, not a provider receipt; a generic error, idle pane, elapsed time or parser reproduction alone is insufficient proof.

```sh
astack runtime authorize-input-retry --attempt <id> --key <input-key> \
  --digest <sha256> --generation <number> --not-submitted --writer-stopped \
  --codex-executable /trusted/bin/codex --json
```

The CLI takes the coordinator lock before opening/migrating state. Library hosts must provide equivalent exclusion and coordinate external controllers. Fresh assignment, accepted policy, ownership, worker name/layout and idle/done input readiness are required. The operation archives the pending input as immutable host-attested retry authorization, then removes its active receipt atomically. It sends no input. Restart or explicitly wake the coordinator to retry the original workflow, or submit the same explicit runtime input. Workflow delivery still rechecks current configuration, checkout, instructions and PR/SHA gates.

The same key is restricted to the same input digest. A new persisted action uses the next generation; legacy actions default to zero. Repeating authorization for an old generation never clears a newer pending/acknowledged action. Delayed old acknowledgements fail their generation comparison. Other uncertain inputs, launches and interrupts remain blocked; no capacity or resources are released. Cancellation or revoked policy prevents new authorization. See [ADR 0013](adr/0013-explicit-host-authorized-input-retry.md).

The prompt adapter passes the text directly after the unique name; protocol 22 does not accept an extra `--` separator there. `pnpm check:herdr-cli /absolute/path/to/herdr` explicitly probes the installed parser against a private nonexistent socket using multiline and dash-prefixed text. It contacts no running server or agent and is excluded from `pnpm check`.
