# ADR 0028: Ensure project workspaces by name

Status: Accepted

Initialization ensures a Herdr primary workspace by default. It uses saved project target settings when present, otherwise the standard default Herdr session/socket; explicit session/socket and workspace name can be selected. The default workspace name is the repository directory name. Preview remains read-only and does not contact Herdr.

An existing workspace with the same name is reused regardless of its contents or checkout. If none exists, Astack creates one. If multiple workspaces have the same name, a previously saved matching workspace is preferred, otherwise the first match is reused. The user is responsible for choosing workspace names. The initialization result reports whether the workspace was created or reused, its name and its handle. A missing provider or incomplete creation is reported as blocked or pending without retrying an uncertain creation.

This supersedes the primary workspace matching portion of ADR 0007. Worker checkout attribution, worker process controls, and resource/recovery handling remain separate. A primary workspace stays open when workers complete. Initialization never starts a coding agent.
