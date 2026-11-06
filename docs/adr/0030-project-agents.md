# ADR 0030: Configure project agents together

Status: Accepted

The editable project file contains named `agents` with provider, model, reasoning and optional instructions. Init writes Codex implementer and reviewer entries with unset model/reasoning so the user or agent chooses them. New jobs retain their accepted settings. Existing configuration and job formats need not be migrated.

The Codex/Herdr adapter supplies its own launch flags. Implementer defaults to workspace-write, reviewer to read-only and Codex approval mode to on-request. New project-agent launches do not require hashes of the executable, local configuration files or host/pane environment, or a separate approved launch profile. They still persist launch intent and verify the selected project, checkout and Herdr pane before effects. Host/provider support and sandbox behavior are not inferred from configuration parsing.

The current optional `hooks` and `execution` structures preserve lifecycle and verification capabilities until their redesign is decided. The Codex runtime still requires the explicit service option. Legacy library-level launch-profile validation remains implemented but is not exposed in the project-agent format.

This supersedes the required project launch-profile parts of ADR 0026 and the starter shape in ADR 0027.
