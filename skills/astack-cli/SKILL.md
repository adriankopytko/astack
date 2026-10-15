---
name: astack-cli
description: Use the astack CLI when asked to work with astack tooling or delegate project implementation and review through astack. Discover installed capabilities before attempting orchestration.
---

# Using astack

## Discover the installed capabilities

Run `astack --skill` to read the guidance shipped with the installed version. This prints Markdown with skill frontmatter to stdout; it does not install a skill, select a project, or start an agent.

Use `astack --help` for command discovery and `astack <command> --help` for supported arguments. Invoke `--skill` on its own, without a subcommand. Help and JSON output remain available separately.

In the astack source checkout, use `pnpm dev` in place of `astack`, for example `pnpm dev --skill`. After building, `pnpm start --skill` uses the compiled CLI. Run these pnpm commands from the astack repository; an installed `astack` binary can print its skill from any directory.

## Commands available now

| Command              | Result                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `astack --skill`     | This agent guide                                                        |
| `astack --help`      | Available commands and options                                          |
| `astack --version`   | Installed package version                                               |
| `astack info`        | Human-readable package information                                      |
| `astack info --json` | Versioned completed result; `value` contains `name`, `version`, `stage` |

The current stage is `foundation`. Project initialization, project selection, worktrees, implementation delegation, review delegation, persistence, and service commands are not implemented yet. Package information is not project or job status. If a request needs one of those capabilities, report the missing capability rather than inventing a command or treating an unknown command as accepted work.

`info --json` returns `{ "schemaVersion": 1, "outcome": "completed", "value": { ... } }`; read package fields under `value`. This replaces the early scaffold's unversioned shape. Library-only explicit context resolution is available through an injected reader; it does not introduce a project-context CLI command. A completed read is an observation, not an accepted job or proof of ownership.

## As orchestration becomes available

Use the installed command contracts to resolve the intended project and distinguish accepted work from completed work. Calling from a directory containing several projects does not establish a unique target. Follow the user's requested implementation/review scope and configured automation policy; an implementation handoff alone does not authorize an automatic review.

For completion, rely on operation results and commit-specific evidence rather than an idle agent or a pushed PR alone. A failed or uncertain command is not evidence that repeating an external effect is safe; inspect its result and supported recovery instructions before retrying.
