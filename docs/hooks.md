# Explicit project lifecycle hooks

Hooks execute selected private-host-approved commands in an exact owned checkout. They do not run during initialization, imports, inspection, service startup or ordinary worker dispatch. The orchestrator explicitly executes each hook; declared setup/start completion is then checked before worker dispatch. Publication verification remains a separate consumer (#33). See ADR 0024.

## Phases and policy

`setup` prepares the project, `verify` runs project checks, `start` invokes the service controller, and `teardown` invokes the stop controller. The existing setup/verify/teardown selections retain their meaning. Optional `start` is additive: omitted fields do not add defaults or change historical configuration/prompt bytes. Required-host-hook checking includes start when explicitly declared.

Portable configuration still proposes only command **names**. A private host policy must approve both the executable/argument vector and the lifecycle binding. For example, within an existing project-bound host policy:

```json
{
  "project": {
    "hooks": {
      "setup": null,
      "verify": "project-check",
      "start": "project-start",
      "teardown": "project-stop"
    }
  },
  "execution": {
    "enabled": true,
    "allowedEnvironment": ["PATH", "APP_PORT"],
    "maxTimeoutMs": 300000,
    "commands": {
      "project-check": { "executable": "/trusted/bin/pnpm", "args": ["run", "check"] },
      "project-start": { "executable": "/trusted/bin/pnpm", "args": ["run", "environment:start"] },
      "project-stop": { "executable": "/trusted/bin/pnpm", "args": ["run", "environment:stop"] }
    },
    "hooks": {
      "verify": {
        "command": "project-check",
        "timeoutMs": 120000,
        "environment": ["PATH"],
        "resources": {}
      },
      "start": {
        "command": "project-start",
        "timeoutMs": 30000,
        "environment": ["PATH"],
        "resources": { "APP_PORT": { "key": "api", "field": "port" } }
      },
      "teardown": {
        "command": "project-stop",
        "timeoutMs": 30000,
        "environment": ["PATH"],
        "resources": { "APP_PORT": { "key": "api", "field": "port" } }
      }
    }
  }
}
```

This is an excerpt, not a complete host policy or a recommendation to invent those scripts. Select actual authored project commands and trusted executable paths. No shell or argument substitution is introduced. Hooks receive literal approved argv, the canonical owned checkout as cwd, and exactly the approved host environment plus resource inputs. No ambient environment is merged. Required names must exist and be host-allowed; secret values are supplied only at execution, never in requests/journals/prompts. Repository changes do not approve executables, new hook bindings or environment names. Missing selections/definitions and policy/proposal drift block execution with diagnostics.

Resource environment bindings select logical reservation keys and `port`, `host`, `protocol` or `name`. Pass the exact saved IDs/revisions for precisely those keys. Their project/job/attempt/checkout must match; foreign or stale reservations are rejected. Returned port/name values become environment values directly, without shell interpolation or authored `.env` rewriting. Commands remain project-specific. The core supplies no Node/Python/database bootstrap defaults and never silently installs dependencies; a deliberately approved setup command can itself perform project setup under its declared authority.

## Commands, targeting and ownership

```sh
astack hooks execute --file /absolute/hook-request.json --json
astack hooks inspect <hook-id> --json
astack hooks exclude-writer --file /absolute/exclusion.json --json
astack hooks reconcile --file /absolute/shutdown.json --json
```

Example execution request:

```json
{
  "schemaVersion": 1,
  "jobId": "job-example",
  "attemptId": "attempt-example",
  "key": "prepare-environment",
  "phase": "start",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "allocations": [{ "id": "allocation-example", "expectedRevision": 1 }],
  "writersExcluded": true
}
```

Select a real full SHA. `allocations` defaults to empty. `writersExcluded: true` is a trusted host attestation that competing checkout/startup controllers and writers are excluded throughout the operation, including native agents that may outlive a stopped service. It is not a worker claim or an automatic conclusion from idleness. Hold coordinator ownership across preflight, command execution, result settlement and drain. The CLI locks before writable open/migration and refuses an active coordinator; inspect uses existing state read-only. Library hosts supply the same exclusion and injected dependencies. There is no arbitrary-command RPC.

The job/attempt selects explicit registered identity; caller cwd/pane does not. A ready owned checkout, matching directory/container identity, branch and explicit current SHA are required. Hooks can run on a completed implementation SHA different from its original base assignment, but never silently retarget the request. Configured job snapshots remain immutable and host policy must still match. Setup/start require an active unresolved attempt; verify supports accepted work states and teardown remains available after cancellation/terminal outcome under the still-approved policy. Revoked/changed policy is never bypassed for teardown: hosts must arrange an explicit approved recovery path or stop outside this operation.

## Intent, execution and evidence

Migration 17 journals deterministic attempt/key invocation IDs, exact request, project/repository/checkout/worktree/branch/full SHA, filesystem identity, policy/command digests, selected environment names and timeout. Command text, argv, environment values and output text are not persisted. A normal cleanup hold and `hook_changed` event are inserted with intent. Claims are synchronous short local transactions and never expire by age. Only one prepared/executing hook writer can hold a checkout.

A prepared intent can be claimed once. Before process effects, start hooks obtain newly persisted resource startup receipts with the hook ID as controller, then recheck policy, target and inputs. Partial receipts remain held if another resource blocks. No command runs unless all receipts are newly confirmed. An existing/uncertain startup receipt is not replay authority. After `executing`, repeating the same hook key only inspects the saved record, even if the original process never spawned. Changed request bytes conflict. A new key cannot bypass an unresolved unknown invocation for ordinary setup/verify/start; explicit teardown remains available once the old executing controller has been excluded and settled.

The existing process runner supplies explicit cwd/env, timeout, cancellation and group evidence. Hook capture is zero bytes, with streams drained and byte counts/completeness retained. No raw output/artifact files are created by this operation. The result records root exit/code/signal, termination cause, original-group state and stream evidence separately. Success requires normal zero exit, original-group absence and complete streams, followed by unchanged branch/SHA/filesystem identity. An absent original group does **not** prove escaped services stopped. Nonzero exit, timeout, cancellation, target drift and uncertain execution remain distinct evidence. An unexpected runner exception or lost completion receipt never authorizes another command.

After execution, explicit assigned ports are probed and `free`/`busy`/`unknown` observations saved; names are `not_probed`. These are observations, not owned-service authentication or permission to release reservations. Start/stop scripts should be bounded service-controller commands for independently managed services, rather than long-running foreground servers: the process runner stops surviving original-group children. Stronger provider containment remains separate.

## Worker dispatch and integration review

Selected setup/start hooks must have successful records bound to the exact attempt/base SHA, selected command and accepted policy before new worker claims. Start resources additionally need independent host confirmation through `resources running`, with the saved startup key/controller and actual owned endpoint/readiness evidence. Hook success or a busy port alone cannot supply that attestation. Transactional capacity claims and native launch/initial-input reservation recheck prerequisites; missing hooks are not silently ignored. Existing native workers are never relaunched to apply hooks. Verify/teardown execute explicitly and do not become background actions.

Static reviews skip setup/start/teardown, create no service hook holds, and remain service-free. A static verify hook cannot consume undeclared integration resources. Integration review can reserve only its saved resource keys, bound to its dedicated attempt/checkout. Dispatch requires successful start evidence and verified running/retained allocations for every declared integration key. Existing implementation or sibling-review resources cannot satisfy it. Host-approved project instructions must explain how the reviewer uses that prepared environment; native agent environment injection and automatic `.env` rewriting are not added. Existing prompt bytes stay unchanged.

## Interrupted setup, teardown and cleanup

Every invocation retains its cleanup hold after process completion. Successful exit is a domain result, not proof that escaped descendants/services stopped. Allocations and hook holds block ordinary worktree cleanup and cannot be released through generic state-resource APIs.

If the original invocation remains executing after a crash, first independently stop/exclude its controller and owned foreground children. `exclude-writer` takes `{schemaVersion,id,expectedRevision,key,writersStopped:true}`. It marks the exact executing/unknown invocation unknown and records writer exclusion; it never asserts service shutdown, changes an accepted outcome into success, releases resources or reruns the command. This frees the hook writer slot so an explicitly authorized teardown can run against the retained environment. Services/escaped provider resources remain held. Never infer this attestation from elapsed time, a saved PID, parser reproduction or worker assertions.

Once independently verified services are stopped, release each exact allocation using its existing shutdown contract and fresh endpoint evidence. Then reconcile the hook with `{schemaVersion,id,expectedRevision,key,writersStopped:true,servicesStopped:true}`. Reconciliation requires matching revision and all referenced allocations already released; it atomically records host shutdown evidence and releases only that hook hold. It never invokes commands. A lost executing result stays unknown; a never-claimed prepared intent becomes cancelled. Identical completed reconciliation is historical reuse; changed evidence conflicts. Native worker shutdown reconciliation and owned worktree removal remain separate.

Cancellation before persistence creates no invocation. Cancellation later can leave prepared/executing intent, partial resource startup receipts or process evidence; preserve them. SIGINT/SIGTERM in the CLI abort/drain the runner while retaining coordinator ownership through settlement. No command, including verify, is automatically retried. An uncertain state commit requires reopen/inspection before further effects. Hosts can supply injected runners, environment readers, resource probes and clocks; imports perform no effects.

CLI errors and unsuccessful/uncertain execute results exit nonzero. Successful control/inspection reads can report historical unknown/failed process outcomes without claiming that the original command succeeded. JSON uses versioned typed envelopes.

## Verification

Disposable owned repositories and controlled runners test two synthetic technology profiles, literal command/cwd/environment inputs, absence of output/credential retention, missing hooks, policy/target/resource drift, failed and cancelled commands, timeouts, unknown/lost execution, partial startup ownership, static/integration review isolation, endpoint evidence, retained cleanup holds, explicit controller exclusion/shutdown and neutral-directory CLI coordinator conflicts. No live user agents, application repositories, GitHub mutations or global configuration changes are required.
