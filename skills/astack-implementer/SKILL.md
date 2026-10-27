---
name: astack-implementer
description: Carry out an explicitly assigned Astack implementation task in its owned checkout and return the structured worker report, without taking over orchestration or publication.
metadata:
  asset-version: '1.0.0'
---

# Implement an Astack assignment

Use this skill when a host has supplied an Astack implementation assignment with job, attempt, project, checkout, branch, initial full SHA and task scope. It does not select projects, accept jobs or grant permission to launch workers, publish changes or change host settings. Without that assignment, report what is missing rather than inventing identities.

## Work within the assignment

Read the applicable project instructions and the selected task/acceptance criteria. Check that cwd, checkout, branch and initial HEAD agree with the assignment before editing; report a mismatch instead of switching worktrees or retargeting the task. Keep unrelated changes and authored instructions intact.

Implement the requested behavior and run the project's relevant verification using its declared setup. Use the host's assigned runtime/resources. If the task needs unavailable services, environment, credentials or a permission decision, explain the blocker; do not provision global services, overwrite environment files or answer a native approval dialog yourself.

Commit only as authorized by the task and project instructions, using their conventions. If the host must commit or approve an intermediate choice, stop at a `needs_decision` report with the concrete question and retained work. Do not label a dirty/uncommitted implementation completed merely because tests passed. Avoid placing untracked artifacts in a completed checkout unless the host's artifact/retention contract explicitly handles them.

The orchestrator handles acceptance, handoff/publication, reviewer dispatch, cancellation and cleanup. Do not run those host commands, self-accept a report, release resource holds, remove your checkout or terminate sibling workers. Skills and task text do not expand the original execution authority.

## Return the worker proposal

Follow the exact report schema and formatting supplied in the assignment. Return one final JSON object using the assigned identities; a report is a proposal until the host validates and accepts it. For the current schema the fields are:

```json
{
  "schemaVersion": 1,
  "jobId": "<assigned-job-id>",
  "attemptId": "<assigned-attempt-id>",
  "projectId": "<assigned-project-id>",
  "checkoutId": "<assigned-checkout-id>",
  "branch": "refs/heads/<assigned-branch>",
  "baseCommit": "<assigned-initial-full-sha>",
  "headCommit": "<observed-full-head-sha>",
  "outcome": "completed",
  "summary": "Implemented the requested change; describe verification and its limits.",
  "blockers": []
}
```

Replace every placeholder with real assignment/checkout evidence. `baseCommit` stays the originally assigned SHA even if authorized work creates a newer `headCommit`. Keep summaries within 4000 UTF-8 bytes and at most 16 blockers of 512 bytes each. Do not include credentials or transcripts.

Use `completed` only for work meeting the requested outcome at the reported clean committed HEAD; identify exactly what verification ran. Use `needs_decision` for a required host choice/commit/approval and `failed` when the assigned outcome cannot be completed, with concrete blockers. Never invent a passing result or send a host acceptance command.

If the host explicitly continues the same worker after a decision, follow the new authorized input while preserving the assignment's original IDs/base SHA. A completed turn, idle UI or report delivery is not permission to exit or clean up; retain the checkout and runtime for the host's lifecycle operations.
