# Agent ports

Each agent can declare named TCP ports in `.astack/config.json`:

```json
{
  "agents": {
    "implementer": {
      "provider": "codex",
      "model": "example-model",
      "reasoning": "high",
      "ports": {
        "APP_PORT": { "range": [20000, 29999] },
        "OAUTH_PORT": { "fixed": 3000 }
      }
    }
  }
}
```

Astack reserves one number per name in its shared host database before the before hook runs. Fixed ports use the same collision rules as ranges. Astack-coordinated jobs sharing that database cannot reserve the same TCP port, including across projects. Astack does not check whether unrelated processes use the range; select a range reserved for Astack or handle an external collision in the project. Separate state databases do not coordinate.

The same values are exported to the before and after scripts and, for Codex/Herdr, to a new tab in the worker's grouped Herdr workspace. The agent receives them through its environment. The reservation stays allocated when a worker needs a decision, while a hook outcome is unknown, or if the after hook fails. On a completed, failed or cancelled task, the service releases reservations after the after hook succeeds; if no after hook is configured it releases them when processing the terminal outcome. This is database coordination, not evidence that an operating-system listener stopped.

Port values are inspectable with `astack resources list --project <id> --json`. Runtime adapters that cannot inject agent ports block jobs that declare them. Opening a grouped workspace and then its environment-configured tab is journaled as one pending layout; an uncertain provider result needs inspection rather than an automatic duplicate tab. No live Herdr/Codex port-injection pilot has been run.
