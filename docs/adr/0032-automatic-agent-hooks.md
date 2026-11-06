# ADR 0032: Automatic agent hooks

Supersedes ADR 0024 and the remaining verification machinery described in ADR 0025.

Each agent may configure optional before and after scripts in the project configuration. The local service runs them automatically around the worker using the saved job configuration. Before failure blocks launch; after failure remains visible and retains managed ports. Unknown invocations are not replayed. See [agent hooks](../hooks.md).

The former explicit hook and verification operations, their legacy configuration, and publication verification are removed. Existing database migrations remain immutable, so their historical tables remain present but unused. Project checks are run using the project’s own tooling. Legacy review resource requests are blocked; use configured agent ports and hooks for new jobs.
