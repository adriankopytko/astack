# Repository guidelines

## Scope and current state

Astack is a reusable Node toolkit for one orchestrator to delegate implementation and review across projects. Keep project-specific technologies, trackers, prompts, and environment schemas out of generic mechanisms.

The development scaffold is installed. The CLI implements help, version, package information and `--skill` agent guidance; project/worktree operations and delegation are not implemented yet. Use [README.md](README.md) and tracked ADRs as the durable contributor contract. Ignored `.planning` material is supplementary local context, not a prerequisite for contributors.

Versioned read contracts and explicit project/checkout resolution through an injected reader are implemented in the library. Follow [the operation contracts](docs/operation-contracts.md) and ADR 0002. Registration, context CLI wiring, and effectful worktree/job operations remain later work; a completed observation establishes no ownership or durable acceptance.

Read-only Git inspection is implemented through `inspectGitRepository` and `createGitInspector`; follow [its contract](docs/git-inspection.md). Use an explicit checkout and trusted executable/runner, preserve full commit IDs and incomplete-output errors, and keep raw remote URLs and diagnostics out of results. Common-directory identity and repeated observations establish neither ownership nor an atomic snapshot; recheck before effects.

The injectable process runner is implemented through `executeProcess` and `nodeProcessRunner`; follow [its contract](docs/process-runner.md). Keep termination cause, root exit, process-group evidence, output completeness, and domain success separate. Do not retry uncertain writes automatically or treat an absent original group as proof that escaped descendants/services stopped. Supply explicit environment and apply retention/redaction policy to captured output and artifacts.

Managed asset writes/inspection and shared private-artifact helpers are implemented; follow [their contract](docs/managed-files.md). Preserve unowned/edited files and unresolved intents, select trusted roots, coordinate writers, and keep operational stage/journal files out of commits. A proposed ownership record is not host authority; automatic pending-write reconciliation and project initialization remain later work.

Typed SQLite persistence is implemented through `openSqliteState` and the state application operations; follow [its contract](docs/sqlite-state.md). Keep immutable numbered migrations in compiled state-adapter modules, transactions synchronous and bounded, and state outside repositories. Persist local intent before external effects, preserve expired claims and uncertain outcomes, and reopen/inspect after an uncertain commit. Storage records and claim tokens are not worker authorization or proof of provider success; service dispatch, registration policy, report validation, and automatic recovery remain later work.

## Toolchain

Use Node 24 LTS, pnpm, strict TypeScript, ESM, and NodeNext module resolution. Honor `.node-version` and `package.json#packageManager`. Preserve the lockfile; do not switch package managers.

Use Oxlint for linting, Oxfmt for formatting, and dependency-cruiser for resolved module boundaries. Pin tools locally. Typed Oxlint rules are enabled with the pinned TypeScript 7/tool combination; retain the authoritative TypeScript check/build. dependency-cruiser uses its separately pinned TypeScript 6 parser via pnpm package extensions. Preserve that compatibility setup until the checker supports our compiler API. Do not introduce another lint/format stack without a demonstrated missing requirement and a documented decision.

Require braces for control statements and put nonempty block bodies on separate lines. Keep one statement per line. Add blank lines before control-flow statements, returns, and throws, and after block-like statements when another statement follows. Keep `else`/`else if` attached to their chain; no extra blank line is needed before the enclosing block's closing brace. Separate `assert(...)`/`assert.*(...)` groups from setup and mutations; consecutive assertions may stay together. Keep ordinary declaration groups together unless there is a meaningful change of step.

Oxlint enforces `eslint/curly` natively and the remaining layout rules through the pinned Stylistic plugin. `pnpm lint:fix` formats, applies lint fixes, and formats again so braces, statement splitting, and spacing are handled together. Meaningful intermediate names and separation of semantic steps still require review; split complicated nested calls when it makes their purpose clearer rather than applying mechanical naming rules.

Use `node:sqlite` for local persistence as recorded in [ADR 0001](docs/adr/0001-use-node-sqlite.md). Hono belongs in service transport code when needed. Start with one package; add packages or architectural infrastructure only for concrete consumers.

## Module boundaries

The intended production dependency directions are:

| Importing layer | Allowed internal dependencies                                                      |
| --------------- | ---------------------------------------------------------------------------------- |
| `contracts`     | `contracts`                                                                        |
| `core`          | `core`, `contracts`                                                                |
| `ports`         | `ports`, `contracts`; type-only imports of core value/result types where needed    |
| `application`   | `application`, `core`, `contracts`, `ports`                                        |
| `adapters`      | `core`, `contracts`, `ports`, and the adapter's own modules                        |
| `cli`           | Inner layers and its own modules; concrete adapters only where wiring dependencies |
| `service`       | Inner layers and its own modules; concrete adapters only where wiring dependencies |

`cli` and `service` must not import each other. Share behavior through application operations and contracts. Extract shared dependency wiring only when needed, with narrow explicit exceptions in the boundary configuration. Adapters must not import application policy or unrelated adapter implementations. Keep runtime interfaces in `ports`; application operations receive implementations through explicit dependencies.

Hono and Commander imports stay in their outer transport/CLI layers. `node:sqlite` stays in the state adapter. Project/provider-specific dependencies stay in their adapters or profiles. Contract schemas may use their declared validation dependency. Type-only imports obey boundaries too, apart from the explicit core-type allowance above.

These rules are enforced with dependency-cruiser using resolved source paths and the actual TypeScript/package resolution configuration. Fail on forbidden edges, cycles, and unresolved dependencies. Include re-exports and static dynamic imports; do not treat barrels or aliases as boundary exemptions. Source must not import tests, fixtures, `dist`, or local planning files.

Computed dynamic imports of internal application modules are prohibited: static analysis cannot reliably resolve them. Future plugin loading needs an explicit contract and documented exception. Public library exports should expose deliberate APIs, not every internal helper. Tests may import modules under test, while production dependency rules still apply to production source.

Use Oxlint restricted-import rules for fast feedback on clearly forbidden packages/import spellings. The graph check is the authority for resolved layer direction. The graph rules are active and validated by isolated dependency fixtures. Computed dynamic imports are prohibited by convention; static graph analysis cannot prove their targets.

## Primitive and operation contracts

Each effectful primitive or operation should document inputs, preconditions, effects, result evidence, failures, retry behavior, and cancellation semantics. Use typed named inputs/results and stable machine-readable errors at public boundaries.

- Execute binaries with explicit argument arrays, cwd, and controlled environment. Avoid shell interpolation of task/provider data.
- Resolve project identity explicitly; background operations must not infer targets from the service cwd or ambient Herdr focus.
- Inject runners, clocks, IDs, and provider dependencies where recovery needs controlled behavior.
- Imports must not execute hooks, launch agents, open a global database, or query providers.
- Keep CLI parsing/rendering and HTTP request objects outside core/application operations.
- Persist accepted intent before recoverable effects. Inspect provider evidence after uncertain effects before retrying or launching another writer.
- Separate requested, queued, started, verified-completed, blocked, cancelled, and unknown outcomes where applicable. Do not promise exactly-once external execution.

## Owned resources and project isolation

Bind jobs and cleanup to project/repository identity, canonical checkout, branch/SHA, attempt, and provider resource handles. Recheck external state immediately before removal. Preserve unowned, dirty, untracked, stale, or uncertain resources; do not force-remove worktrees or delete task branches during routine cleanup.

Use one shared allocator for managed ports and service names across projects. A database port reservation is not an OS socket reservation. Verify startup endpoints and shutdown before releasing reservations. Never kill an unrelated listener or overwrite a user-managed environment to fix a conflict.

Select the primary Herdr workspace from the target project's registry, not the calling pane. Keep job cleanup separate from closing a project group. Accepted reports establish task outcomes; idle agent status does not.

Configuration initialization preserves authored skills, instructions, scripts, and environment files. Trusted host execution policy is distinct from proposed PR configuration. Keep credentials out of configuration, prompts, database records, reports, and logs; never log arbitrary environment dumps.

## Development checks

Use the repository's pnpm scripts: `build`, `typecheck`, `lint`, `check:boundaries`, `format:check`, and applicable isolated tests. The combined `check` script includes the graph check, build and isolated tests. `pnpm test` builds before exercising compiled CLI entrypoints. Use `pnpm dev` for development; do not invent service/delegation commands before they exist.

Use Node's test runner with disposable Git repositories, temporary state directories/databases, controlled child processes, and injected dependencies. Default verification must not start real user agents, mutate GitHub tracking, or use live user-project resources. Live-provider checks are explicit opt-in. Prefer tests of ownership, retry, interruption, stale SHA, and race behavior over tests that merely repeat implementation details.

Exclude `.planning`, generated output and local service state from routine formatting, source checks, tests and package contents. Configure exclusions explicitly rather than assuming all tools honor gitignore.

## Documentation and changes

Use Conventional Commits for commit messages: `<type>[optional scope]: <description>`, for example `feat(cli): add project selection` or `fix(core): preserve dirty worktrees`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes.

Keep changes bounded and build primitives with an actual consuming operation. Record durable architecture decisions under `docs/adr/`; update README when runnable commands or capabilities change. Clearly distinguish implemented behavior from planned interfaces. Preserve unrelated user changes and avoid introducing automatic publication or extra provider side effects into routine development.

Update `skills/astack-cli/SKILL.md` when CLI commands or their operation contracts change. This is the canonical guide printed by `astack --skill`; preserve its package inclusion and resolution independent of cwd. Describe available behavior accurately and keep future capabilities explicitly marked as planned.
