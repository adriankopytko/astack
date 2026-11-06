# Legacy verification

The former Astack verification CLI and publication gate have been removed. Run project checks using the project's own tooling. A successful handoff does not prove that checks were run or passed; the accepted report should describe what the worker actually checked.

Legacy internal verification records and operations remain temporarily while the old lifecycle hooks are replaced. They are not used to authorize publication and are not part of the supported CLI workflow. See [ADR 0031](adr/0031-remove-publication-verification-gate.md).
