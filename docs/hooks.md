# Agent lifecycle hooks

Each agent can define optional `before` and `after` shell command strings in `.astack/config.json`. They are saved with the accepted job configuration and run automatically by the local service in that job's checkout:

```json
{
  "schemaVersion": 1,
  "agents": {
    "implementer": {
      "provider": "codex",
      "model": "example-model",
      "reasoning": "high",
      "hooks": {
        "before": "pnpm install && pnpm run start:services",
        "after": "pnpm run stop:services"
      },
      "hookTimeouts": { "before": 600000, "after": 60000 }
    }
  }
}
```

Scripts use `/bin/sh -c` and inherit the service environment, with the checkout's `node_modules/.bin` prepended to `PATH`. Commands intended to leave services running must start them in the background and return; the after script should stop them. Astack does not capture script output. Do not put credentials in command strings.

The coordinator waits for capacity and checks the assignment before running `before`. A nonzero exit blocks worker launch. `after` runs for completed, failed or cancelled runs; it does not run while an agent needs a decision. A failure in `after` does not change an accepted worker result. Inspection and `hook_changed` events show outcomes. Invocation intent is persisted before the process starts. A timed-out, interrupted or otherwise uncertain invocation is retained and never automatically repeated; there is no automatic retry or recovery operation yet.

The former `astack hooks` commands and legacy top-level hook configuration are no longer supported. Older internal records remain in state pending removal of the old implementation. Configured agent ports are allocated automatically and passed to both scripts and the worker; see [agent ports](agent-ports.md).
