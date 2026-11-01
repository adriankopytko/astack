# Project configuration

Astack reads a project's settings from **one editable file**, `.astack/config.json` in its registered primary checkout. `astack init` creates a disabled starter and tells the user or agent where to fill it. Astack does not inspect the project to invent commands. Use the project's instructions and tooling to decide which runtime, commands, hooks and verification are appropriate.

```sh
astack init /path/to/project --preview --json
astack init /path/to/project --json
# Edit /path/to/project/.astack/config.json deliberately.
astack config approve --project <project-id> --json
astack config inspect --project <project-id> --role implementer --json
```

`config approve` records only the SHA-256 digest of the exact current file in private host state; it does not copy project settings there. It requires exclusive coordinator ownership, validates project identity and the configuration schema, and executes no project commands. Editing even whitespace changes the digest and requires a fresh explicit approval. An absent, changed or invalid file cannot authorize new work. An accepted job retains an immutable configuration snapshot and is rechecked before dispatch and effects; approving a changed file does not silently retarget that job.

The default host state directory is `~/.astack`, shared across projects. It holds the registry, job records, resource state, approval digests and other host-owned operational data. Project configuration stays in the repository. Existing installations using `~/.local/state/astack` can select it explicitly with the global `--state-directory` option. Astack does not automatically move, delete or merge old state. Existing legacy private project policies remain readable when no new project config exists; initialization preserves that legacy setup rather than shadowing it. Migrate those settings deliberately and approve the resulting single project file.

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

The project and repository identities come from the host registry, not this file. Optional `user`, `project`, `local` and request patches retain their existing merge precedence; they are fields within the one configuration document, not copies in host state. Objects merge by field, arrays replace whole arrays, and `null` disables optional bindings. Execution controls set allowed runtimes, commands, environment names, timeout ceilings and required hooks. They are not merged from task requests.

Replace starter values deliberately. Executables and argv are explicit; no shell interpolation or automatic dependency installation is added. Keep credentials and environment values out of project configuration, command arguments, prompts and reports. A command approval permits the program and its code dependencies to run; it does not establish a sandbox.

Optional `execution.hooks` defines named lifecycle commands and resource/environment bindings; see [hooks](hooks.md). `execution.verification[role]` defines required baseline checks and allowed lane/additional checks; see [verification](verification.md). `execution.launchProfiles` supplies adapter-specific Codex role settings; see [launch profiles](launch-profiles.md). Optional `execution.review.allowNoChecks` grants explicit no-CI handling under the [review gate contract](review.md).

## Inspection and job snapshots

`config inspect` and `config check` are aliases. They read registered identity, approved configuration and prerequisites without executing commands. Missing approval, disabled execution, invalid configuration and missing prerequisites block readiness. The operation returns provenance and a snapshot, but not command argv, environment values or skill contents. Readiness is an observation; launch and workflow operations have separate preconditions.

The registered primary checkout supplies the approved project policy. A selected checkout's project settings are inspected as a proposal and changes to those settings block acceptance until reconciled. The full approved policy digest is bound to job snapshots; changing and approving policy does not change a previously accepted job. Unknown/incomplete writes do not replay automatically. The private approval is not a sandbox or protection against a malicious actor with the same host authority.

## Limits and failure handling

Configuration files must be bounded UTF-8 JSON; the project file is limited to 64 KiB and symlink/unsafe path checks apply. Approval records and their directories are private and managed; edited, foreign or pending approval files are preserved. A changed file after approval returns the configuration to an unapproved state. Re-run `config approve` only after reviewing the changed contents and excluding competing controllers. If a write is interrupted, inspect the managed-file intent rather than deleting journals or retrying an uncertain effect under a different identity.

Legacy private policies use their previous host-baseline semantics until deliberately migrated. State and configuration changes require an explicit host-selected target. Other ongoing effects, resource reservations, worker shutdown and cleanup remain separate. See [ADR 0027](adr/0027-single-project-configuration.md) and [initialization](initialization.md).
