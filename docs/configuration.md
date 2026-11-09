# Project configuration

Astack reads a project's settings from **one editable file**, `.astack/config.json` in its registered primary checkout. `astack init` creates an incomplete starter and tells the user or agent where to fill it. Astack does not inspect the project to invent commands. Use the project's instructions and tooling to decide which runtime, commands, hooks and verification are appropriate.

```sh
astack init /path/to/project --dry-run --json
astack init /path/to/project --json
# Edit /path/to/project/.astack/config.json deliberately.
astack doctor --project <project-id> --role implementer --json
```

The file is used directly: there is no approval command or editable host copy. At job acceptance, Astack saves the resolved project configuration in the private state database alongside the job. The accepted job uses that saved configuration for dispatch, launch and hooks. Editing the project file changes new jobs, not already accepted jobs, and unrelated edits do not block an existing worker.

The saved job record currently includes the project configuration, including configured agent instructions and any optional command arguments. Ambient environment values are not copied. The private data is not returned in ordinary job or configuration inspection output, but is present in the private local database. Do not put credentials, tokens or secret environment values in configuration or command arguments. Existing jobs created before per-job configuration storage do not have the required saved data and must be submitted again; Astack does not silently substitute the mutable project file.

The orchestrator does not receive the file automatically: it uses Astack's commands and reads or edits the project file when needed. Astack reads the latest file when accepting a new job. The user's coding agent is responsible for loading its own skills and project instructions.

The default host state directory is `~/.astack`, shared across projects for registry, jobs and resources. Old host policy and approval files are no longer read; they are left on disk. Existing installations using `~/.local/state/astack` can select that directory explicitly with `--state-directory`. Astack does not automatically delete or migrate old state.

## Starter

A fresh `.astack/config.json` contains agent entries without a model or reasoning level. Fill in both for each agent you want to use:

```json
{
  "schemaVersion": 1,
  "agents": {
    "implementer": {
      "provider": "codex",
      "model": null,
      "reasoning": null,
      "permissions": { "files": "write" }
    },
    "reviewer": {
      "provider": "codex",
      "model": null,
      "reasoning": null,
      "permissions": { "files": "readonly" }
    }
  }
}
```

Each agent selects a `provider`, `model` and `reasoning`. Model and reasoning are required to accept that agent's job. An optional `instructions` string is included in that worker's assignment. Other named agents can be configured; a matching runtime adapter must be available. The built-in provider is `codex` through Herdr. Supported Codex reasoning values are `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.

Agent entries may specify `hooks.before` and `hooks.after` as package-script-style shell command strings. The local service runs `before` before starting the worker and `after` after a completed, failed or cancelled task; it keeps the environment for `needs_decision`. Defaults are 10 minutes for `before` and 60 seconds for `after`; optional `hookTimeouts.before` and `hookTimeouts.after` set millisecond overrides. Scripts run in the task checkout with the service environment and the checkout’s `node_modules/.bin` on `PATH`, like package scripts. The command exit is recorded; output is not captured. A failed `before` blocks launch; a failed `after` remains visible in `run inspect` while preserving the task result. Hook start and completion generate `hook_changed` events. Unknown executions are not automatically repeated.

Each agent may declare named ports, for example `"ports": { "APP_PORT": { "range": [20000, 29999] }, "OAUTH_PORT": { "fixed": 3000 } }`. The service reserves ports before the before hook and exports them to hooks and the worker. Ranges coordinate only with other Astack jobs using the same state directory; they do not probe unrelated applications. See [agent ports](agent-ports.md).

Astack maps `permissions.files` to the provider: Codex `readonly` uses `read-only`, and `write` uses `workspace-write`. If omitted, reviewers default to `readonly` and other agents to `write`. Both use Codex's `on-request` approval mode. No executable/version/file digest or approval profile is required. The CLI service makes the Codex runtime available when Codex and Herdr are installed; jobs select it from their saved project configuration.

`astack config-schema` prints the current machine-readable JSON Schema for humans, agents and editors. To use it in VS Code, run `astack config-schema > .astack/schema.json` and add `"$schema": "./schema.json"` to `.astack/config.json`. Regenerate the schema after upgrading Astack. Schema validation describes the file shape; `astack doctor` also checks saved project context and prerequisites, including supported Codex reasoning values.

Legacy top-level hook and verification settings are not accepted. Keep credentials and secret environment values out of project configuration, command arguments, prompts and reports.

## Inspection and job snapshots

`doctor` reads the registered primary checkout configuration and prerequisites without executing commands. Missing or invalid configuration and missing prerequisites block readiness. The configuration result includes provenance and a snapshot, but not command argv, environment values or skill contents. Readiness is an observation; launch and workflow operations have separate preconditions.

The primary checkout supplies configuration for new jobs, including jobs using task worktrees. Each accepted job retains its own private configuration and immutable public snapshot. Dispatch rechecks the saved checkout and prerequisites; configuration edits alone do not block the saved job. Unknown or incomplete writes do not replay automatically.

Library hosts using their own persistence adapters must atomically save the supplied policy with the accepted job and provide `ConfigurationReader.readJobPolicy` for later reads. A missing saved policy blocks dispatch; the current project file is not used as a substitute.

## Limits and failure handling

Configuration files must be bounded UTF-8 JSON; the project file is limited to 64 KiB and symlink/unsafe path checks apply. State changes require an explicit host-selected target. Other ongoing effects, resource reservations, worker shutdown and cleanup remain separate. See [ADR 0029](adr/0029-job-configuration-snapshots.md) and [initialization](initialization.md).
