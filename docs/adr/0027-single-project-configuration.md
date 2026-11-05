# ADR 0027: Single project configuration and host approval digest

Status: Superseded in part by ADR 0028

The project owns one editable `.astack/config.json`. Initialization creates a disabled starter and asks the user or agent to fill it. The registered primary checkout supplies project settings and execution controls; host state no longer duplicates them for new projects. Explicit host approval saves only the file's digest, and changed bytes require renewed approval. Saved job policy digests and dispatch rechecks continue to protect in-flight assignments.

The default host state moves to `~/.astack` for shared registry, queue, resources and approval metadata. The previous state directory is never silently moved or deleted; it remains selectable explicitly. Existing legacy policies are read only when no project config exists, and initialization preserves such setup rather than creating a competing file.

This supersedes the separate project proposal and copied host baseline parts of ADR 0005, and the host-policy starter/default-location parts of ADR 0022. It does not change resource, worker or publication recovery contracts.
