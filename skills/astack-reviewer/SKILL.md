---
name: astack-reviewer
description: Review an explicitly assigned Astack PR and full commit SHA in a dedicated read-only checkout and return structured findings with the supplied scope and readiness snapshots.
metadata:
  asset-version: '1.0.0'
---

# Review an Astack assignment

Use this skill for a host-provided Astack review assignment containing job/attempt/project/checkout IDs, exact PR host/repository/number/full head SHA, base SHA, gate policy and acceptance snapshot. It does not authorize choosing another PR, launching agents, publishing findings, approving or merging. Missing assignment evidence is a blocker, not an invitation to discover a different target.

## Check the reviewed scope

Read applicable repository instructions and the assigned review scope. Verify the dedicated checkout is at the assigned branch and full head SHA and that the diff is against the assigned base. Preserve the host's exact target and snapshots; do not silently review a newer head or infer identity from ambient GitHub/Herdr context.

Review statically without editing files, creating commits, running setup or starting services. Evaluate concrete defects and missing behavior against the task/specification and changed code. Use project-specific review instructions where applicable. An integration/service request stays blocked until the host provisions and authorizes it; this worker cannot bypass the static-review contract.

CI/readiness is separate from correctness. Keep missing, pending, failed, skipped and cancelled checks distinct. Do not change the supplied gate, invent current provider observations or turn a stale acceptance snapshot into fresh passing evidence. If the scope moved or fresh evidence is unavailable, report the limitation/decision using the assignment's contract.

## Return structured findings

Return one final JSON proposal with the exact schema in the assignment. The current report includes:

- `schemaVersion: 1`, assigned `jobId`, `attemptId`, `projectId`, `checkoutId` and the exact `target` object (`host`, `repository`, `number`, full `sha`).
- `outcome`: `reviewed`, `needs_decision` or `failed`; a concise `summary`; and `blockers`.
- `findings`: actionable items with `severity` (`critical`, `high`, `medium`, `low`), a safe repository-relative `path`, a **positive numeric** `line`, and a concrete `description`.
- `gate` and `acceptanceSnapshot`: exact copies of the supplied assignment values. `currentSnapshot` is the independently obtained matching snapshot only when available under the assignment's read contract; otherwise use `null`. Never substitute the local clock for an observation or invent passing checks.

For example, a finding has this shape:

```json
{
  "severity": "high",
  "path": "src/format-duration.js",
  "line": 12,
  "description": "Hours wrap at 24, so a duration of 90000 seconds returns 1h instead of 25h."
}
```

This is a schema example, not a finding to copy into unrelated reviews. Use actual changed-code evidence. Lines are numbers, not strings such as `"12-14"`. Use a path inside the repository without traversal or an absolute prefix. Keep at most 32 findings, descriptions within 1000 UTF-8 bytes, and at most 16 blockers of 512 bytes each. Use an empty findings array for an independently reviewed scope with no actionable findings; it does not approve/merge the PR or assert that CI passed.

A report remains a proposal until the host validates current assignment, artifacts and acknowledged input. Do not self-accept it through the CLI or publish a GitHub review/comment. The host decides whether to accept historical scope, publish findings, or delegate fixes. Fixes run in a fresh implementation checkout; do not turn this reviewer into an implementer.

After returning the report, preserve the checkout and worker for explicit host lifecycle handling. UI done/idle is neither task acceptance nor verified shutdown. Do not remove worktrees, close a project group or release resource holds.
