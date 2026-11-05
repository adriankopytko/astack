# ADR 0028: Read project configuration directly

Status: Accepted

The registered primary checkout is the single source of project configuration and execution controls. Astack uses `.astack/config.json` as it stands, without a host approval step or saved approval digest. Changes apply to new jobs. Existing accepted jobs retain immutable snapshots and are subject to existing drift checks before effects.

Old host policy and approval files remain untouched but are not read. The selected task checkout does not provide a competing policy. Runtime opt-ins, resource ownership and recovery checks remain separate.

This supersedes the approval and legacy policy portions of ADR 0027 and the separate trusted host baseline and repository proposal portions of ADR 0005.
