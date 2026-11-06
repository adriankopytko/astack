# Project configuration

Astack reads a project's settings from **one editable file**, `.astack/config.json` in its registered primary checkout. `astack init` creates an incomplete starter and tells the user or agent where to fill it. Astack does not inspect the project to invent commands. Use the project's instructions and tooling to decide which runtime, commands, hooks and verification are appropriate.

```sh
astack init /path/to/project --dry-run --json
astack init /path/to/project --json
# Edit /path/to/project/.astack/config.json deliberately.
astack doctor --project <project-id> --role implementer --json
```

The file is used directly: there is no approval command or editable host copy. At job acceptance, Astack saves the resolved project configuration in the private state database alongside the job. The accepted job uses that saved configuration for dispatch, launch, hooks and verification. Editing the project file changes new jobs, not already accepted jobs, and unrelated edits do not block an existing worker.

The saved job record currently includes the project configuration, including configured agent instructions and any optional command arguments. Ambient environment values are not copied. The private data is not returned in ordinary job or configuration inspection output, but is present in the private local database. Do not put credentials, tokens or secret environment values in configuration or command arguments. Existing jobs created before per-job configuration storage do not have the required saved data and must be submitted again; Astack does not silently substitute the mutable project file.

The orchestrator does not receive the file automatically: it uses Astack's commands and reads or edits the project file when needed. Astack reads the latest file when accepting a new job. The user's coding agent is responsible for loading its own skills and project instructions.

The default host state directory is `~/.astack`, shared across projects for registry, jobs and resources. Old host policy and approval files are no longer read; they are left on disk. Existing installations using `~/.local/state/astack` can select that directory explicitly with `--state-directory`. Astack does not automatically delete or migrate old state.

## Starter

A fresh `.astack/config.json` contains agent entries without a model or reasoning level. Fill in both for each agent you want to use:

```json
{
  "schemaVersion": 1,
  "agents": {
    "implementer": { "provider": "codex", "model": null, "reasoning": null },
    "reviewer": { "provider": "codex", "model": null, "reasoning": null }
  }
}
```

Each agent selects a `provider`, `model` and `reasoning`. Model and reasoning are required to accept that agent's job. An optional `instructions` string is included in that worker's assignment. Other named agents can be configured; a matching runtime adapter must be available. The built-in provider is `codex` through Herdr. Supported Codex reasoning values are `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.

Astack provides the Codex launch arguments. The implementer defaults to `workspace-write`; the reviewer defaults to `read-only`; both use Codex's `on-request` approval mode. These are current defaults, not configurable project options. No executable/version/file digest or approval profile is required. The service still requires `--codex-herdr` to install the built-in runtime.

Optional top-level `hooks` and `execution` settings retain the existing lifecycle and verification operations while their redesign is under discussion. See [hooks](hooks.md) and [verification](verification.md). They are not needed merely to delegate a worker. Keep credentials and secret environment values out of project configuration, command arguments, prompts and reports.

## Inspection and job snapshots

`doctor` reads the registered primary checkout configuration and prerequisites without executing commands. Missing or invalid configuration and missing prerequisites block readiness. The configuration result includes provenance and a snapshot, but not command argv, environment values or skill contents. Readiness is an observation; launch and workflow operations have separate preconditions.

The primary checkout supplies configuration for new jobs, including jobs using task worktrees. Each accepted job retains its own private configuration and immutable public snapshot. Dispatch rechecks the saved checkout and prerequisites; configuration edits alone do not block the saved job. Unknown or incomplete writes do not replay automatically.

Library hosts using their own persistence adapters must atomically save the supplied policy with the accepted job and provide `ConfigurationReader.readJobPolicy` for later reads. A missing saved policy blocks dispatch; the current project file is not used as a substitute.

## Limits and failure handling

Configuration files must be bounded UTF-8 JSON; the project file is limited to 64 KiB and symlink/unsafe path checks apply. State changes require an explicit host-selected target. Other ongoing effects, resource reservations, worker shutdown and cleanup remain separate. See [ADR 0029](adr/0029-job-configuration-snapshots.md) and [initialization](initialization.md).
