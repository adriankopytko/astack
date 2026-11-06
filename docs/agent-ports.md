# Ports for agent work

Each agent's task checkout may need its own copy of an application and its services. A port value must therefore belong to the worker attempt, not just to the project. Use the shared host allocator so Astack-coordinated workers across projects do not choose the same protocol and port. A temporary bind probe is not a socket reservation; startup must still handle an unrelated process winning a bind race.

## Herdr capabilities

Herdr 0.9.0's local help and the [Herdr CLI reference](https://herdr.dev/tui/docs/cli-reference/) show that `tab create` and `pane split` accept repeatable `--env KEY=VALUE` arguments. These apply to the newly created shell. `agent start` starts an agent in an existing pane and has no `--env` option. Astack can therefore allocate a port, create the worker pane with `--env PORT=...`, and start Codex in that pane; the new Codex process inherits the shell environment. This has not been implemented or tested against a live worker in Astack.

Pass the same allocated values to the before hook that starts project services. Support multiple named ports such as `APP_PORT` and `API_PORT`, and do not place credentials in command arguments or the project configuration. The service must actually bind the assigned value; an environment variable cannot force an application to use it. The shared allocator already binds reservations to a job and attempt, but automatic allocation, propagation into a Herdr pane, service startup/readiness, and shutdown/release are not wired together.

The initial assignment should tell the agent which endpoints are available. A worker needing fixed ports should be able to request them explicitly; if unavailable, report the conflict rather than kill another listener. An allocated port number is not proof that the expected service owns the endpoint or that the service is ready.
