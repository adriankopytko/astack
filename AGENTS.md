# Repository guidelines

## Scope and current state

Astack is a reusable Node toolkit for one orchestrator to delegate implementation and review across projects. Keep project-specific technologies, trackers, prompts, and environment schemas out of generic mechanisms.

The development scaffold is installed. The CLI implements help, version, package information, `--skill` guidance, project registration/listing, context/doctor diagnostics, owned worktree lifecycle, trusted configuration inspection, the local service/queue, and explicit Herdr project/worker layout operations. Opt-in interactive Codex sessions and runtime controls are implemented; explicit implementation delegation is implemented; manual review delegation is implemented; durable run reports/events, explicit continuation and cancellation are implemented. Use [README.md](README.md) and tracked ADRs as the durable contributor contract. Ignored `.planning` material is supplementary local context, not a prerequisite for contributors.

Versioned read contracts and explicit project/checkout resolution through an injected reader are implemented in the library. Follow [the operation contracts](docs/operation-contracts.md) and ADR 0002. Generic service submission/dispatch is implemented through injected runtimes; explicit implementation handoff is implemented; manual review handoff is implemented; a completed observation establishes no ownership or durable acceptance.

Read-only Git inspection is implemented through `inspectGitRepository` and `createGitInspector`; follow [its contract](docs/git-inspection.md). Use an explicit checkout and trusted executable/runner, preserve full commit IDs and incomplete-output errors, and keep raw remote URLs and diagnostics out of results. Common-directory identity and repeated observations establish neither ownership nor an atomic snapshot; recheck before effects.

The injectable process runner is implemented through `executeProcess` and `nodeProcessRunner`; follow [its contract](docs/process-runner.md). Keep termination cause, root exit, process-group evidence, output completeness, and domain success separate. Do not retry uncertain writes automatically or treat an absent original group as proof that escaped descendants/services stopped. Supply explicit environment and apply retention/redaction policy to captured output and artifacts.

Managed asset writes/inspection and shared private-artifact helpers are implemented; follow [their contract](docs/managed-files.md). Preserve unowned/edited files and unresolved intents, select trusted roots, coordinate writers, and keep operational stage/journal files out of commits. A proposed ownership record is not host authority; automatic pending-write reconciliation and project initialization remain later work.

Typed SQLite persistence is implemented through `openSqliteState` and the state application operations; follow [its contract](docs/sqlite-state.md). Keep immutable numbered migrations in compiled state-adapter modules, transactions synchronous and bounded, and state outside repositories. Persist local intent before external effects, preserve expired claims and uncertain outcomes, and reopen/inspect after an uncertain commit. Storage records and claim tokens are not worker authorization or proof of provider success; workflow report validation is implemented separately; broader provider recovery remains later work.

Project registration and CLI context selection are implemented; follow [their contract](docs/projects.md) and ADR 0003. Explicit saved-attempt/checkout/project/path selectors must agree and take priority over caller-directory discovery. Preserve distinct linked checkout IDs, stale filesystem identity evidence, and deliberate registration markers. Read-only diagnostics do not initialize state or grant execution policy; registration does not initialize project files or authorize workers.

Owned worktree prepare/inspect/remove/reconcile operations and CLI commands are implemented; follow [their contract](docs/worktrees.md) and ADR 0004. Persist intent before effects, retain pending writer claims, and verify ownership, directory identity, branch retention, and tracked/untracked/ignored files before removal. Never force-remove, prune, or delete task branches. Manual reconciliation requires an operation-bound trusted host attestation that the writer and its children stopped; do not infer it from age, PID absence, idle status, or worker assertions. Provisioning and automatic resource cleanup remain later work; runtime launch uses its separate contract.

Trusted configuration resolution, configured job acceptance, and a dispatch configuration gate are implemented; follow [their contract](docs/configuration.md) and ADR 0005. Repository settings are proposals; only private host-approved baselines and execution controls grant policy authority. Preserve declared merge precedence, whole-array replacement, per-leaf provenance, immutable job snapshots, and exact skill digests. Recheck policy/revocation and prerequisites before dispatch. Readiness is an observation; hooks and initialization remain later work. Context/doctor checks identity and leaves configuration `not_checked`; use `config inspect` for configuration evidence.

The foreground local service, durable queue, capacity claims and conservative restart inspection are implemented; follow [their contract](docs/service.md) and ADR 0006. Hold kernel-backed coordinator ownership across all effects/draining; never replay claimed launches or release uncertain capacity by age. Use explicit saved assignments, separate worker quiescence from domain results, and preserve unowned endpoints. The CLI enables codex-herdr only through explicit host opt-in; otherwise runtime adapters remain empty. Unix socket transport requires local host binding permission.

Herdr settings, persistent primary spaces, grouped owned worker layouts and verified detected-agent bindings are implemented; follow [their contract](docs/herdr.md) and ADR 0007. Use explicit saved session/socket and canonical registered provenance; labels/focus/ambient pane variables are not identity. Keep pending writes and retained worker resources, require fresh group/terminal/foreground-cwd attribution, and preserve primary spaces. Protocol 22 socket identity is transport evidence, not a server-issued UUID or worker authorization. This layer does not launch agents, close workspaces, or install service runtime adapters.

Interactive Codex launch/inspect/input/interrupt/reconcile and service wiring are implemented; follow [the runtime contract](docs/runtime.md) and ADR 0008. Herdr owns execution; preserve one stable launch and digest-only keyed action intent before provider effects. Require verified unique attempt name, pane/terminal/cwd attribution and refreshed accepted policy for new controls. Native session IDs are optional supplementary evidence captured at binding; a captured ID must remain present and unchanged. Target input/interrupt by the saved unique agent name. Host controllers must not reuse reserved names. Server canonical executable resolution/ambient configuration require host trust; protocol 22 cannot atomically guard targets or prove quiescence/delivery. Never replay pending launch/input, answer approval dialogs automatically, or treat Escape/UI done as cancellation/completion. Implementation prompts now consume this runtime separately; provisioning remains later work; run operations validate host-supplied reports separately.

Explicit implementation acceptance, deterministic initial input and saved status inspection are implemented; follow [the implementation contract](docs/implementation.md) and ADR 0009. Require an explicit ready owned checkout and persist task/instruction references, policy and attempt before launch. Workflow-capable runtimes declare support and use durable idempotent input receipts. Never resend pending/acknowledged input or reinterpret worker proposals/UI done as accepted completion. Keep instruction contents, host credentials and arbitrary transcripts out of delivery records. Worktree preparation stays explicit; remote report authentication and cleanup remain later work.

Explicit manual review is implemented; follow [the review contract](docs/review.md) and ADR 0010. Bind project/base repository/PR/full SHA, dedicated owned reviewer checkout, manual authorization, gate policy and durable attempt. Same-target reuse/request aliases must be transactional; deliberate repeats require a new key and checkout. Never retarget a stale head, turn skipped/missing checks into passing evidence, or let repository config grant CI overrides. Keep static review free of services, integration resource requests blocked until provisioned, and report proposals unaccepted until the explicit run acceptance operation validates them. No background scanner is installed.

Durable run inspection, host-supplied report acceptance, monotonic local events/cursors, decision responses, explicit same-worker continuation and cancellation are implemented; follow [run operations](docs/runs.md) and ADR 0011. Append events with their mutations transactionally; do not acknowledge consumers while reading. Validate current assignment/artifacts and acknowledged input before accepting a proposal. Preserve unknown delivery and never retry it with a new key. Cancellation blocks new claims/launch/input but an interrupt does not prove shutdown. Task outcome, native liveness and cleanup remain separate; no automatic cleanup, report harvesting or runtime wake-up is implemented.

Targeted GitHub reads and publication effects follow [the GitHub contract](docs/github.md) and ADR 0015. Keep host/repository/full-SHA targeting explicit, paginate bounded collections, and preserve ambiguous/missing/nonpassing checks. Use the existing effect journal for publication intent and claim before effects; pending/unknown writes never replay by age or absence. Reconcile only after host confirmation that original writers stopped, querying exact actor/body/marker/target evidence without POST. Publication is a host capability, separate from worker result acceptance, issue transitions and handoff policy. Keep JSON bodies in private owned request files, never argv; imports/service startup must not enable writes.

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
| `host`          | Inner layers, concrete adapters and service transport; no CLI policy               |

`cli` and `service` must not import each other. Share behavior through application operations and contracts. The exact composition exceptions are `src/cli/service.ts` → `src/host/local-service.ts` and `src/cli/runs.ts` → `src/host/reconcile-run.ts`; other CLI/host edges are forbidden. Keep other shared dependency wiring narrow and explicit. Adapters must not import application policy or unrelated adapter implementations. Keep runtime interfaces in `ports`; application operations receive implementations through explicit dependencies.

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

Runtime input recovery follows [ADR 0013](docs/adr/0013-explicit-host-authorized-input-retry.md). Keep the coordinator stopped/excluded and require independent host evidence of non-delivery plus stopped original controllers before explicit retry authorization. Preserve the original attempt/key/digest/generation and audit record; never infer permission from idleness, age, generic errors or a parser reproduction alone. New sends use newer generations and old acknowledgements must fail. Optional installed-Herdr CLI probes use private nonexistent sockets and stay outside default checks.

Explicit structured report collection and offline shutdown reconciliation follow [ADR 0014](docs/adr/0014-explicit-report-collection-and-shutdown-reconciliation.md). Keep provider log parsing behind `RunReportReader`; select one session explicitly and send proposals through ordinary report acceptance. Saved version 1/2 prompt bytes must remain stable; new review assignments use prompt version 3 with a numeric finding-line example. Reconciliation requires coordinator exclusion, exact launch/revision, fresh provider absence and truthful host shutdown attestations; never derive them from UI status. Atomically release only matching known resource bindings, preserve unknown holds and accepted outcomes, and keep worktree removal separate.

The Codex/Herdr adapter adds the fixed per-invocation setting `-c check_for_update_on_startup=false` so native update menus do not block worker startup. Keep Codex upgrades under host control; do not change global/project Codex configuration or broaden the role argument allowlist to arbitrary config overrides. Existing blocked workers are never relaunched to apply a startup setting.
