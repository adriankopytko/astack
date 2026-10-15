# Bounded process execution

Issue #8 provides a library operation and an injectable Node implementation. There is no general execution CLI command or service endpoint.

```ts
import { executeProcess, nodeProcessRunner, processResultSchema } from 'astack';

const result = processResultSchema.parse(
  await executeProcess(
    {
      schemaVersion: 1,
      executable: process.execPath,
      args: ['--version'],
      cwd: '/absolute/project/path',
      env: {},
      timeoutMs: 5000,
    },
    nodeProcessRunner,
    // optional AbortSignal
  ),
);
```

Use an actual absolute cwd for the selected checkout. `ProcessRunner` is the port for controlled implementations and future provider consumers. It accepts a validated `ProcessRequest`; application callers should enter through `executeProcess(unknown, runner, signal?)` so strict input/version validation precedes effects. Injected runners are trusted execution dependencies, not worker-supplied configuration. They must preserve uncertain effects; an unexpected rejected promise is not evidence that execution did not happen.

## Inputs and preconditions

The caller authorizes the executable, arguments, cwd, environment, and optional artifact location. This primitive does not implement project permissions or sandboxing and must not be exposed as an unrestricted service command. It runs with the host process's OS permissions. Later service/provider operations must enforce their configured execution boundary before invoking it.

| Field                | Contract                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | Integer `1`; unknown positive versions are rejected                                                                               |
| `executable`         | Absolute host path, or bare name with a nonempty explicitly supplied `env.PATH`; relative paths containing `/` are rejected       |
| `args`               | Required string array, passed literally without a shell                                                                           |
| `cwd`                | Required absolute host path; not an implicit project selector or ownership proof                                                  |
| `env`                | Required record of strings; no ambient environment merge. Keys cannot contain `=` or NUL; values and arguments cannot contain NUL |
| `timeoutMs`          | Required positive integer, at most 2,147,483,647 ms                                                                               |
| `maxCaptureBytes`    | Prefix retained per stream; default 65,536 bytes, range 0–16 MiB                                                                  |
| `terminationGraceMs` | Delay before escalation; default 250 ms, range 0–10,000 ms                                                                        |
| `shutdownWaitMs`     | Verification budget after escalation; default 1000 ms, range 1–10,000 ms                                                          |
| `artifacts`          | Optional existing trusted parent `directory` and required `maxBytesPerStream` from 0–1 GiB                                        |

Stdin is closed (`ignore`), never inherited or left waiting for interactive input. The operation does not provide a terminal. A caller can explicitly choose a shell executable, but no shell is introduced implicitly and task text is never interpolated into one by the runner.

The supported hosts are Linux and macOS. Other hosts return `unsupported_platform` before artifact creation or process launch. Missing executables, inaccessible paths, and invalid cwd produce spawn evidence rather than raw exception text. No provider discovery, package installation, retry, or project setup occurs.

## Execution and shutdown evidence

The result uses a process-specific schema rather than the completed-read envelope:

| `outcome`               | Meaning                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exited`                | The direct child exited; inspect `exitCode`, `signal`, output completeness, and group state. This includes nonzero exit codes and external signals |
| `timed_out`             | The execution/collection deadline requested stopping; not proof of shutdown                                                                        |
| `cancelled`             | The caller requested stopping, or the signal was already aborted before launch                                                                     |
| `spawn_failed`          | No successful spawn was observed; safe system code is retained                                                                                     |
| `io_failed`             | Artifact setup, collection, or persistence failed; execution may already have had effects                                                          |
| `descendants_remaining` | The root exited while its group remained present or uncertain; owned-group teardown was requested                                                  |
| `rejected`              | Invalid/unsupported request or unsupported platform; no process or artifact work began                                                             |

`pid`, `exitCode`, and `signal` report the direct child only. An exit does not establish task completion or successful verification. `error` retains a fixed diagnostic category and an allowlisted OS code; it never copies argv, env, cwd, or raw exceptions. Output emitted by the command is separate, potentially sensitive data.

The Node implementation starts a new POSIX session/process group with `detached: true`; its group ID is the spawned child's PID. The parent still observes the child and its pipes. While the command is running, cancellation and timeout send SIGTERM to that group. After the configured grace, a remaining/uncertain group receives one SIGKILL attempt. A root exit with remaining children initiates the same bounded teardown. Stop causes are retained rather than changed to `exited` after termination succeeds.

`shutdown` records independent evidence:

- `root`: `not_started`, `exited`, or `unverified`.
- `processGroup`: `not_started`, `absent`, `present`, or `unknown`, based on a signal-0 probe of this invocation's group. Permission/probe failures remain unknown. Zombies can keep a group present until reaped.
- `termSent` and `killSent`: signal calls succeeded. They are not proof that all processes stopped.

Once absence is observed, the runner never signals that group again. PID/group evidence is scoped to this live invocation; it is not a durable recovery handle and must not authorize later cleanup from a saved PID. Final observations are snapshots, not a lease.

Process groups do not contain descendants that deliberately create another session/group. The runner does not enumerate or kill unrelated groups. An escaped descendant may retain the output pipes; the timeout and shutdown budget end collection without claiming that descendant stopped. `processGroup: 'absent'` proves only the original group was absent at observation time, never that every descendant or service is gone.

## Deadline and cancellation

Strict validation runs first. An already aborted signal prevents artifact creation and launch. Cancellation during artifact preparation closes created files and prevents launch once preparation returns; partial empty artifacts may remain for inspection. The process deadline starts immediately before spawn and includes stream collection. Cancellation is checked at roughly 20 ms intervals without adding persistent signal listeners.

Termination is bounded by the execution deadline (or cancellation/root-exit trigger), grace, and shutdown-wait budget, with scheduling overhead. At that boundary, pipes are destroyed, process handles are unreferenced, and uncertain shutdown remains explicit. Completed reads/file handles are finalized before returning. Filesystem operations, OS scheduling, and blocked disk IO are not hard real-time or forcibly cancellable; artifact preparation/finalization can add latency. Providers requiring stronger containment need a separate runtime contract.

No automatic retry occurs. A timeout, cancellation, nonzero exit, stream error, or unknown group state can follow an external mutation. Inspect operation-specific evidence before retrying Git publication, provider launch, or another write. A fresh `executeProcess` call starts a fresh invocation; it is not an idempotent resume.

## Bounded output and artifacts

Each stream retains a fixed-size byte prefix and continues draining after that prefix fills. Optional artifact writes are awaited sequentially per stream for backpressure; a slow artifact does not build an unbounded application write queue. Capture, stream buffering, and artifact budgets are independent.

`stdout` and `stderr` each contain:

- `text`: a UTF-8 view of the retained prefix, potentially lossy for binary data or a cut multibyte sequence.
- `capturedBytes` and `observedBytes`: raw byte counts, not string lengths; observed bytes are what the collector read, not a guarantee about bytes the command attempted to produce.
- `truncated`: some observed bytes were not retained in memory.
- `complete`: EOF was observed; forced pipe closure or read failure remains incomplete.
- `artifact`: null, or an absolute local reference with written byte count, truncation, and completeness.

Do not parse truncated or incomplete output as a complete structured provider response. Exported result schemas reject inconsistent byte counts, truncation flags, and fabricated exit evidence; they cannot prove OS facts or infer a command's business success.

With artifacts enabled, the runner creates a unique private `process-*` subdirectory under the trusted parent, and exclusively opens `stdout.bin` and `stderr.bin` with mode 0600 (subject to umask). It does not overwrite earlier artifacts or authored files. Files retain raw bytes independently of the smaller text capture. Hitting an artifact budget retains a reported prefix and keeps draining; it does not silently claim a full log. An artifact is complete only after EOF, retention of every observed byte, and successful file close.

Artifact/write failure requests owned-group shutdown and retains available references and partial evidence. The runner does not delete artifacts on success, failure, or cancellation. The caller owns retention and cleanup, including private empty directories from interrupted setup. File close is not a power-loss durability guarantee (`fsync` is not promised). The managed-files primitive can later centralize these ownership mechanisms.

Captured text and artifacts can contain whatever the command prints, including secrets. The runner does not log or publish them and cannot infer/redact arbitrary secret values. Select a controlled environment and permitted capture policy; callers must redact/select evidence before storing it in wider-access state, prompts, or GitHub. The artifact parent must be caller-owned/trusted; path syntax is not a trust check or a defense against an adversarial parent-directory replacement.

## Verification

Default tests use controlled child fixtures and disposable directories only. They cover literal arguments/paths, explicit environment and PATH, missing executable/cwd, nonzero exits/signals, bounded/discarded output, raw/private/capped artifacts, pre-launch failure/cancellation, deadline shutdown, SIGTERM resistance and SIGKILL escalation, remaining descendants, and an escaped process holding pipes open. Fixture processes have an independent expiry; the escaped test process is explicitly stopped by its test owner.

No live user agents, application services, or GitHub mutations are part of these checks. Linux/macOS CI exercises the same cases; platform-specific verification remains the recorded group observation rather than an assumption that zombies have already been reaped.

The behavior follows Node's [detached process](https://nodejs.org/docs/latest-v24.x/api/child_process.html#optionsdetached) and [signal](https://nodejs.org/docs/latest-v24.x/api/process.html#processkillpid-signal) APIs. Process-group observation is deliberately narrower than verified service or resource shutdown.
