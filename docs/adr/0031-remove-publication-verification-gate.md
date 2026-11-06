# ADR 0031: Remove the Astack verification gate for publication

Status: Accepted

Supersedes the publication-gating decision in ADR 0025. Projects and agents can run their own checks using their existing tooling. Astack handoff no longer requires or rechecks a separate executed verification record before pushing or creating a pull request. The accepted report, owned checkout, exact commit, publication intent and existing recovery rules remain in effect. A successful handoff does not prove that checks were run or passed.

The legacy verification and hook operations remain temporarily while automatic agent lifecycle hooks are redesigned. Their continued availability does not make them a publication requirement.
