# Trusted project and role configuration

## Available operations

`resolveConfiguration(request, dependencies, signal?)` resolves schemaVersion 1 settings for an explicit registered project and optional checkout. A role is required. Dependencies inject the registry, Git inspector, checkout identity reader, configuration reader, and prerequisite probe. No caller directory, provider focus, hook execution, or agent launch participates in resolution.

```sh
astack config inspect --project <project-id> [--checkout <checkout-id>] [--role implementer] [--json]
astack config check --project <project-id> --role reviewer --json
```

These commands are aliases. They open existing state read-only, inspect configuration, and report prerequisites. Exit 0 means configuration is ready at observation time; exit 1 means blocked or rejected. Missing state/config is never initialized. `context`/`doctor` remain identity diagnostics: they report configuration as `not_checked` and direct users here. Configuration readiness does not mean delegation or providers are implemented.

## Three separate kinds of data

| Data                                          | Location                                                   | Authority                                                     |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| Portable proposed settings                    | `.astack/project.json` in the explicitly selected checkout | Proposal only; never merged directly into execution settings  |
| Approved settings and host execution policy   | `<state-directory>/config/<project-id>.json`               | Explicitly authored by the trusted host/operator              |
| Registration, paths, runtime/provider handles | Private state and host policy                              | Local identity/execution details; never portable project data |

There is no approval/import/init command yet. The host/operator deliberately creates a private `config` directory with mode 0700 and a project policy file with mode 0600. `project list --json` supplies project IDs; `context --project <id> --json` supplies the repository ID. These are identities, not secrets. Registering a project alone grants no execution permission.

The filesystem reader requires canonical, owner-private host policy directories and files outside Git repositories, with no linked/hard-linked policy files. Parent traversal for repository proposals rejects symlinks; proposals are bounded regular files. Host JSON is limited to 64 KiB, snapshots to 16 KiB, and a job record to the existing 32,768-character storage limit. JSON must be valid UTF-8. Invalid schemas and unsafe files fail with fixed messages without echoing bytes or validator diagnostics. Oversized combined settings reject rather than truncating.

### Portable proposal example

```json
{
  "schemaVersion": 1,
  "settings": {
    "roles": {
      "implementer": {
        "runtime": "codex",
        "command": "coding-agent",
        "timeoutMs": 300000,
        "environment": [],
        "skills": []
      },
      "reviewer": {
        "runtime": "codex",
        "command": "coding-agent",
        "skills": []
      }
    },
    "hooks": { "verify": "project-check" }
  }
}
```

Runtime and command names are generic identifiers. This example does not install a runtime adapter or run a command. Portable settings cannot contain executable paths, argv, environment values, project registration IDs, or provider handles. Skills reference an ID, version and SHA-256 digest of exact approved bytes. Each role may request environment variable **names**; never store their values here.

### Host policy example

Replace the example IDs and absolute executable path with deliberate host values before using this policy:

```json
{
  "schemaVersion": 1,
  "projectId": "project-example",
  "repositoryId": "repository-example",
  "revision": "v1",
  "user": {},
  "project": {
    "roles": {
      "implementer": { "runtime": "codex", "command": "coding-agent" },
      "reviewer": { "runtime": "codex", "command": "coding-agent" }
    }
  },
  "local": {},
  "execution": {
    "enabled": false,
    "allowedRuntimes": ["codex"],
    "allowedEnvironment": [],
    "maxTimeoutMs": 300000,
    "requiredHooks": { "setup": null, "verify": null, "teardown": null },
    "commands": {
      "coding-agent": { "executable": "/absolute/host/bin/codex", "args": [] }
    },
    "skills": []
  }
}
```

`project` is the host-approved portable baseline, copied deliberately after review. `user` and `local` default to empty patches. For this first consumer they are explicit layers in the project-bound host file; Astack does not discover a global user file or checkout-local override automatically. This keeps the effective inputs explicit and lets later tooling supply shared user settings through the reader port.

Execution is disabled in this example. Explicitly enable it only for an intended execution profile. Commands use absolute executables and fixed argv arrays; there is no shell interpolation or automatic setup detection. Command approvals are project-wide: role/request settings may select any approved command. They do not provide per-role capability isolation. A future profile requiring narrower permissions must express that distinction before launching workers.

A command entry approves execution of that program and its code dependencies; it is not a sandbox or a guarantee about scripts the program may load. Keep credential values out of argv, JSON, skill files, prompts and reports. Host command paths/argv are excluded from resolution results and saved snapshots; their full normalized policy contributes to the policy digest.

## Precedence and merge rules

The order, lowest to highest, is:

**built-in defaults → user → approved project → local → request**

Objects merge by declared fields, including individual roles and hooks. Arrays replace in full; they never concatenate. An empty array explicitly clears the lower-priority array. Omitted fields inherit; `null` explicitly disables a command/runtime or hook where permitted by its schema. There is no generic deletion operator, executable configuration module, environment interpolation, or unknown-field passthrough.

Built-in roles are `implementer` and `reviewer`, each with no runtime/command, a 300,000 ms timeout, and empty skill/environment lists. Setup, verification and teardown hooks default to null. Additional role names are supported within the schema limits. A new role starts from the same empty role defaults.

For example, a local timeout of 120,000 overrides a project timeout of 300,000. A request skill list replaces the complete previous list. Every resulting leaf records `defaults`, `user`, `project`, `local`, or `request` provenance, including whole-array provenance. The CLI inspects the default request layer; library callers can provide a bounded request patch.

Execution controls are a separate host-only object and never participate in this merge. After merging, Astack enforces execution enablement, approved runtimes/command references, allowed environment names, the host timeout ceiling, exact skill approvals, and mandatory hook IDs. Requests cannot remove a mandatory verification hook or raise a timeout above the host ceiling.

## Proposals and prerequisites

A present repository proposal is compared structurally with the approved `project` patch, independent of object-key order. Arrays retain order. A changed proposal blocks configuration and asks the host to review and explicitly update its approved baseline. A proposal containing host execution fields is invalid. Its bytes never grant permissions. A proposal that was not inspected because policy is missing is reported as `not_checked`. An absent proposal is reported as absent; host-authored projects can operate without a tracked proposal.

The filesystem prerequisite probe checks only selected role commands and configured hooks, approved environment-name presence, and exact approved skill bytes. Executables must currently be executable regular files, but are never invoked by inspection. Environment values never leave the host adapter. An empty value is considered unavailable by CLI wiring. Approved skill files live outside repositories in canonical private host directories and are private regular files; their SHA-256 digest must match. Proposed skill contents are never evaluated automatically.

Diagnostics identify missing/disabled policy, unknown roles, unapproved runtime/command/environment/skills, excessive timeouts, changed mandatory hooks, unavailable executables/environment/skills, changed proposals, changed policy, or missing job snapshots. Each includes an actionable next step. Raw Git diagnostics, config bytes, command arguments, skill text, and environment values are not returned. Arbitrary role/command/skill identifiers are not a place to encode secrets.

## Job acceptance and dispatch gate

`acceptConfiguredJob({ schemaVersion: 1, job, role, request: requestPatch }, dependencies, signal?)` resolves configuration through trusted dependencies and, only when ready, calls the state store to persist the job **with its snapshot in the same acceptance transaction**. It accepts no requester-supplied snapshot. Job/project/repository/checkout identities must agree. It queues no work and starts no agent.

The immutable snapshot includes project/repository/checkout, selected role, human policy revision, content-derived policy digest, effective settings/digest, request patch, leaf provenance, and selected skill IDs/versions/digests. It omits host command argv, host skill paths and environment values. A human revision alone is insufficient: changing permissions or argv without bumping it still changes the policy digest.

The existing job JSON gains an optional `configuration` field; no SQL migration is needed. The job idempotency fingerprint includes this field when present, preserving hashes for legacy records. Repeating acceptance with the same effective policy returns the original job; changing policy under the same key returns `state_conflict`. Use a new explicit job/key after reviewing a change. Legacy low-level `acceptStateJob` remains available to trusted persistence callers but does not establish execution authorization.

`checkConfigurationDispatch({ schemaVersion: 1, job: savedJob }, dependencies, signal?)` is the library preflight for a trusted, freshly read saved job. It re-resolves using its saved request and explicit checkout, then compares the complete snapshot. Legacy jobs without a snapshot block. Changed policy/revision/settings/skill pins require new acceptance. Current disabled execution, missing executables/environment, edited skill bytes, changed proposals and stale checkout identities also block, even if the accepted snapshot itself is unchanged.

Refresh at actual dispatch: host policy and revocation, mandatory hooks/timeouts, command/runtime/environment allowlists, executable availability, environment presence, pinned skill bytes, and registered checkout identity. The dispatcher must separately verify attempt/branch/SHA assignment, ownership, provider/runtime readiness and host resource policy. It must consume the same trusted command definition whose policy digest it checked, construct a controlled environment and recheck immediately before effects. A ready result is an observation, not a durable capability, lease or authorization token.

## Effects, retries, failures and cancellation

Resolution and dispatch checking read only. They do not initialize files/state, execute hooks, launch agents, mutate Git, persist approval, or fetch providers. Repeating them is safe; observations can change. Job acceptance performs one bounded SQLite write after successful reads. Standard state contention, idempotency and uncertain-commit rules apply; an uncertain write must be reopened/inspected before retrying. No external effect needs retrying here.

Requests validate before reads. Cancellation before persistence rejects without acceptance. Once the state transaction returns a verified committed result, a later abort does not relabel it as cancelled. Filesystem reads have byte limits; injected implementations must honor cancellation and bounded work. Reads and Git/filesystem/probe observations are not an atomic host snapshot. Coordinating host policy writers and refreshing at dispatch are required; these operations do not prevent a hostile same-user writer or executable replacement between checking and execution.

Stable errors are `configuration_invalid`, `configuration_unsafe`, `configuration_unavailable`, and `configuration_blocked`, plus existing request/context/state errors. Missing prerequisites are a completed resolution with `status: blocked`, diagnostics and, when possible, a non-authoritative snapshot. Missing state is a state error. No partial settings are accepted after invalid input.

The [generic local service](service.md) consumes these contracts. Runtime adapters and explicit [project initialization](initialization.md) now consume these contracts separately. Explicit [hook execution](hooks.md) consumes private execution.hooks command/deadline/environment/resource bindings without changing repository authority. General credential injection, cross-project user profile loading and automatic approval remain later work.

## Explicit no-CI permission

The optional private `execution.review.allowNoChecks` flag permits a reviewer gate that explicitly requests `allowNoChecks: true` to accept a wholly empty check set with no selected required names. It defaults through absence to no permission, preserves existing policy digests when absent, and is independent of `allowGateOverride`. Repository proposals cannot grant it. Normal observed failing/pending/skipped/cancelled checks do not pass. See [CI observation](ci.md) and [review gates](review.md).

Optional `hooks.start` and `execution.requiredHooks.start` are additive; omission preserves historical merged defaults and snapshot bytes. Private `execution.hooks` defines selected setup/verify/start/teardown command names, bounded timeouts, approved environment names and explicit resource-field inputs. Matching repository names alone never authorize execution. Configuration inspection still launches nothing; accepted jobs with selected setup/start hooks wait for exact invocation evidence at dispatch. See [hook policy and recovery](hooks.md).

Private `execution.verification[role]` selects required baseline checks, allowed named lane/additional check definitions and explicit `maxAgeMs`. Accepted snapshots retain a bounded digest-only approval plan when configured; omission preserves legacy bytes but grants no executed-verification capability. Actual checks use named verify hooks, while publication validates the approved baseline transactionally. No argv or environment values enter that plan. See [executed verification](verification.md).

Private `execution.launchProfiles` maps roles to `{ runtime, settings }` provider profiles. Repository proposals cannot grant this authority. The opaque JSON settings are interpreted only by the selected runtime adapter; absent fields preserve legacy snapshots. New Codex starts require [validated launch profiles](launch-profiles.md), independently of ordinary configuration readiness.
