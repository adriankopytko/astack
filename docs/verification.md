# Legacy verification

The former Astack verification CLI, public verification operations and publication gate have been removed. Run project checks using the project's own tooling. A successful handoff does not prove that checks were run or passed; the accepted report should describe what the worker actually checked.

Historical verification tables remain as part of the database migration history; Astack does not use them for new work. See [ADR 0031](adr/0031-remove-publication-verification-gate.md).
