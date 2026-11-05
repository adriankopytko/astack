# Project configuration

Astack reads a project's settings from **one editable file**, `.astack/config.json` in its registered primary checkout. `astack init` creates a disabled starter and tells the user or agent where to fill it. Astack does not inspect the project to invent commands. Use the project's instructions and tooling to decide which runtime, commands, hooks and verification are appropriate.

```sh
astack init /path/to/project --dry-run --json
astack init /path/to/project --json
# Edit /path/to/project/.astack/config.json deliberately.
astack config inspect --project <project-id> --role implementer --json
```

The file is used directly: there is no approval command or editable host copy. At job acceptance, Astack saves the resolved project configuration in the private state database alongside the job. The accepted job uses that saved configuration for dispatch, launch, hooks and verification. Editing the project file changes new jobs, not already accepted jobs, and unrelated edits do not block an existing worker.

The saved job record currently includes the project configuration, including configured command arguments and launch profiles. Explicitly configured nonsecret launch-profile paths such as `HOME` and `PATH` are included; ambient environment values are not copied. The private data is not returned in ordinary job or configuration inspection output, but is present in the private local database. Do not put credentials, tokens or secret environment values in configuration or command arguments. Existing jobs created before per-job configuration storage do not have the required saved data and must be submitted again; Astack does not silently substitute the mutable project file.

The orchestrator does not receive the file automatically: it uses Astack's commands and reads or edits the project file when needed. Astack reads the latest file when accepting a new job. The user's coding agent is responsible for loading its own skills and project instructions.

The default host state directory is `~/.astack`, shared across projects for registry, jobs and resources. Old host policy and approval files are no longer read; they are left on disk. Existing installations using `~/.local/state/astack` can select that directory explicitly with `--state-directory`. Astack does not automatically delete or migrate old state.

## Starter

A fresh `.astack/config.json` is disabled and contains null role/hook selections and empty execution controls. Its shape is:

```json
{
  "schemaVersion": 1,
  "revision": "init-v1",
  "project": {
    "roles": {
      "implementer": { "runtime": null, "command": null },
      "reviewer": { "runtime": null, "command": null }
    },
    "hooks": { "setup": null, "verify": null, "teardown": null }
  },
  "execution": {
    "enabled": false,
    "allowedRuntimes": [],
    "allowedEnvironment": [],
    "maxTimeoutMs": 300000,
    "requiredHooks": { "setup": null, "verify": null, "teardown": null },
    "commands": {},
    "skills": []
  }
}
```

The project and repository identities come from the host registry, not this file. Optional `user`, `project`, `local` and request patches retain their existing merge precedence; they are fields within the single editable project configuration. Objects merge by field, arrays replace whole arrays, and `null` disables optional bindings. Execution controls set allowed runtimes, commands, environment names, timeout ceilings and required hooks. They are not merged from task requests.

Replace starter values deliberately. Executables and argv are explicit; no shell interpolation or automatic dependency installation is added. Keep credentials and secret environment values out of project configuration, command arguments, prompts and reports. Configuring a command permits the program and its code dependencies to run; it does not establish a sandbox.

Optional `execution.hooks` defines named lifecycle commands and resource/environment bindings; see [hooks](hooks.md). `execution.verification[role]` defines required baseline checks and allowed lane/additional checks; see [verification](verification.md). `execution.launchProfiles` supplies adapter-specific Codex role settings; see [launch profiles](launch-profiles.md). Optional `execution.review.allowNoChecks` grants explicit no-CI handling under the [review gate contract](review.md).

## Inspection and job snapshots

`config inspect` and `config check` are aliases. They read the registered primary checkout configuration and prerequisites without executing commands. Missing or invalid configuration, disabled execution and missing prerequisites block readiness. The operation returns provenance and a snapshot, but not command argv, environment values or skill contents. Readiness is an observation; launch and workflow operations have separate preconditions.

The primary checkout supplies configuration for new jobs, including jobs using task worktrees. Each accepted job retains its own private configuration and immutable public snapshot. Dispatch rechecks the saved checkout and prerequisites; configuration edits alone do not block the saved job. Unknown or incomplete writes do not replay automatically.

Library hosts using their own persistence adapters must atomically save the supplied policy with the accepted job and provide `ConfigurationReader.readJobPolicy` for later reads. A missing saved policy blocks dispatch; the current project file is not used as a substitute.

## Limits and failure handling

Configuration files must be bounded UTF-8 JSON; the project file is limited to 64 KiB and symlink/unsafe path checks apply. State changes require an explicit host-selected target. Other ongoing effects, resource reservations, worker shutdown and cleanup remain separate. See [ADR 0029](adr/0029-job-configuration-snapshots.md) and [initialization](initialization.md).
