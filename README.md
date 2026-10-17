# astack

Reusable tooling for delegating implementation and code review to coding agents across projects.

One orchestrator selects work and decides what happens next. Astack prepares owned checkouts, launches workers, records handoffs and results, and handles authorized waiting and recovery. The initial integrations are Git, GitHub CLI, Herdr, and Codex. Project profiles and hooks keep application-specific setup outside the orchestration core.

## Status

The development scaffold is ready: a compiled CLI/library, strict TypeScript, typed Oxlint rules, Oxfmt, dependency checks, isolated tests, and Linux/macOS CI. The CLI provides help, version, package information, `--skill` guidance, project registration/listing, context/doctor diagnostics, owned worktree lifecycle commands, and trusted configuration inspection. Agent delegation and the service are the next implementation slices.

The library now provides versioned read results and explicit project/checkout context resolution through an injected reader. See [operation contracts](docs/operation-contracts.md) for the executable APIs and the separate durable v1 design.

The library also provides `executeProcess(request, runner, signal?)` and `nodeProcessRunner`: explicit argv/cwd/environment, bounded output and optional private artifacts, timeout/cancellation, and observed Linux/macOS process-group teardown. See [the process runner contract](docs/process-runner.md). It does not add a general execution CLI command or establish service shutdown from a process exit.

Managed-file operations can create or upgrade owned generated assets, preserve detected edits/collisions, and inspect interrupted publication. Ownership/version/digest records and pending intents live with the selected root; large process output uses separate private artifacts. See [managed files](docs/managed-files.md) for path policy, concurrency limits, and recovery boundaries. Project initialization and automatic reconciliation are later operations.

`inspectGitRepository(request, inspector, signal?)` now reads canonical repository/checkout identity, full refs and commit targets, worktree registration, remote endpoint summaries, and tracked/untracked status through an injected Git adapter and process runner. It performs no registration or ownership claim. See [Git inspection](docs/git-inspection.md) for supported selectors, execution controls, and consistency limits. Context and registration consume this API through the CLI.

`openSqliteState(request)` opens private local state with numbered transactional migrations. Library operations persist project identity projections, idempotent job intent, attempts and pending effects, short claims, terminal results, and resource records. The store supplies the original context reader; the returned registry serves project operations. Optional read-only mode supports diagnostics without bootstrap or migration. See [SQLite state](docs/sqlite-state.md) for API contracts, isolated directories, contention, and uncertain-commit handling. Saving intent does not launch an agent or validate a worker report; service dispatch remains planned. Configured acceptance adds an approved policy snapshot without launching a worker.

`project register [path]`, `project list`, and `context` (alias `doctor`) connect Git inspection to explicit local registration. Select a project, checkout, saved attempt, or path from any directory; without selectors, inspect the nearest repository. Read-only diagnostics do not initialize missing state or grant execution authority. See [project registration and context](docs/projects.md) for selectors, stale-location checks, and provider/configuration readiness.

`worktree prepare`, `inspect`, `remove`, and `reconcile` now manage isolated owned checkouts at explicit commit SHAs. Ownership is persisted before Git writes; routine cleanup preserves dirty/untracked/ignored files and task branches. Interrupted effects remain pending until operation-bound host quiescence confirmation and fresh evidence permit reconciliation. See [owned worktrees](docs/worktrees.md) for contracts, supported Git configuration, and recovery limits.

`config inspect` (alias `config check`) resolves approved project/role settings, explains their sources, compares repository proposals, and reports missing prerequisites. Library operations accept jobs with immutable policy/skill snapshots and recheck configuration before future dispatch. Host permissions are separate from portable settings. See [trusted configuration](docs/configuration.md). No hooks or agents execute during inspection.

Local planning material is intentionally ignored. Durable contributor requirements belong in this README, [AGENTS.md](AGENTS.md), and tracked architecture decisions.

## First delivery

- Explicit implementation and review delegation with durable jobs, results, and blockers.
- Manual review by default; optional review after a validated implementation handoff and configured CI gate.
- Safe worktree ownership, retry, cancellation, and restart reconciliation.
- Project selection from an explicit target or an unambiguous registered repository.
- A primary Herdr workspace per enabled project, with grouped worker workspaces.
- Shared port and service-name allocation across managed projects.
- Idempotent project initialization, project-owned setup/verification hooks, and focused skills.

Next, add the local service and runtime integration. Broader task scheduling, automatic fix loops, additional providers, remote execution, and public hosting follow concrete usage.

## Development stack

| Area                  | Convention                                                       |
| --------------------- | ---------------------------------------------------------------- |
| Runtime               | Node 24.20.0 (`.node-version`)                                   |
| Package management    | pnpm with an exact package-manager pin and committed lockfile    |
| Language/build        | Strict TypeScript, ESM, NodeNext resolution, compiled JavaScript |
| Development execution | tsx where useful; separate TypeScript checking                   |
| Lint/format           | Oxlint and Oxfmt, pinned locally                                 |
| Module boundaries     | dependency-cruiser over resolved dependencies                    |
| Verification          | Node's test runner and isolated fixtures                         |
| Storage               | SQLite through `node:sqlite`                                     |
| HTTP transport        | Hono on Node when the service transport is implemented           |

Start with one package and explicit module boundaries. Library operations remain callable without CLI or HTTP request objects. Hono supplies transport; project selection, scheduling, ownership, and recovery remain application logic.

Oxlint type-aware rules are enabled with pinned `oxlint-tsgolint` and TypeScript 7. dependency-cruiser currently requires the TypeScript 6 compiler API; `pnpm-workspace.yaml` pins that parser within the checker without changing the application compiler. That file configures this single package and does not define a monorepo. TypeScript compilation remains authoritative for build/type checking. Oxc linting and formatting do not replace the dependency graph check.

## Intended layout

```text
src/
  contracts/     schemas, persisted formats, results and errors
  core/          process, file and Git mechanisms
  ports/         provider/runtime/storage interfaces
  application/   project, worktree, job and handoff operations
  adapters/      Git, GitHub CLI, Herdr and SQLite implementations
  cli/           command parsing, rendering and dependency wiring
  service/       scheduling, lifecycle, transport and dependency wiring
tests/
  integration/   disposable repository/process/state scenarios
  fixtures/      controlled programs, repositories and hooks
  support/       isolated state paths and injected dependencies
docs/adr/        durable architecture decisions
skills/          skills for implemented operation contracts
profiles/        project-specific hooks and policies
```

Create modules as they are needed. [The dependency rules](AGENTS.md#module-boundaries) are enforced by `pnpm check:boundaries` and exercised with allowed/forbidden dependency fixtures. Computed dynamic imports remain prohibited because static dependency analysis cannot resolve arbitrary expressions.

## Development

Use the pinned Node and pnpm versions, then:

```bash
pnpm install --frozen-lockfile
pnpm dev --help
pnpm dev --skill
pnpm dev info --json
pnpm dev context --json
pnpm dev project list --json
pnpm check
```

| Command                             | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `pnpm dev <arguments>`              | Run the CLI from TypeScript                                               |
| `pnpm build`                        | Clean and compile JS, declarations and source maps                        |
| `pnpm start <arguments>`            | Run the compiled CLI after building                                       |
| `pnpm typecheck`                    | Check source, tests and tooling                                           |
| `pnpm lint`                         | Run typed Oxlint checks                                                   |
| `pnpm lint:fix`                     | Format, fix lint rules for readable blocks and spacing, then format again |
| `pnpm check:boundaries`             | Validate resolved production dependencies                                 |
| `pnpm format` / `pnpm format:check` | Write/check Oxfmt formatting                                              |
| `pnpm test`                         | Build and run isolated library, CLI, and boundary tests                   |
| `pnpm check`                        | Run formatting, lint, types, boundaries, build and tests                  |

The package remains private. `pnpm pack --pack-destination .cache` can inspect its distribution allowlist; it does not publish. SQLite migrations ship as compiled adapter modules; Hono wiring will be added with the service transport. Dependency installation explicitly allows esbuild's setup script for tsx; scripts fail on stale dependencies instead of silently reinstalling them.

Default checks use temporary repositories, databases, and child processes. They must not operate on user projects, live agent sessions, or GitHub tracking. Live-provider checks require explicit opt-in. Linux and macOS are the initial portability targets.

## Agent guidance

`astack --skill` prints the bundled [CLI skill](skills/astack-cli/SKILL.md) as Markdown with YAML frontmatter. Agents can read it directly; it is an additional output option alongside help and command-specific JSON. Use it without a subcommand. It does not install instructions or launch agents.

The skill ships in the package and is resolved relative to the CLI module, so the installed command works from any directory. Keep this guide aligned with implemented commands as the CLI grows. During development, use `pnpm dev --skill` from this repository.

## Read operation results

`info --json` emits `{ "schemaVersion": 1, "outcome": "completed", "value": { "name": "astack", "version": "0.1.0", "stage": "foundation" } }`. This replaces the initial scaffold's unversioned JSON shape. Human-readable `info` is unchanged. Library calls accept versioned requests and return completed observations or rejections with stable error codes.

For example, `getApplicationInfo({ schemaVersion: 1 }, '0.1.0')` returns that envelope. `resolveProjectContext(request, reader, signal?)` resolves an explicit registered project/checkout using read-only facts supplied by the caller. It does not inspect cwd, register projects, run Git, or establish resource ownership. The package exports schemas to validate both results and decoded JSON. See [ADR 0002](docs/adr/0002-version-operation-contracts.md) for the versioning decision.

## State and safety

Runtime state and artifacts live outside source checkouts, with an explicit state-directory override for isolated development. GitHub owns live issue/PR state; local storage owns job intent, attempts, observations, outcomes, and resources.

Track publication, CI, review, and cleanup independently. Bind evidence to full commit SHAs. Preserve dirty or unowned resources, reconcile uncertain effects before retrying, and never treat an idle agent as a completion report.

See [the SQLite decision](docs/adr/0001-use-node-sqlite.md) for persistence constraints.

## License

[MIT](LICENSE).
