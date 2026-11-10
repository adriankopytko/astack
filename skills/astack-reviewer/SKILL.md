---
name: astack-reviewer
description: Review an assigned change in an Astack handoff and report actionable findings.
metadata:
  asset-version: '1.0.2'
---

# Review the assigned change

Read the handoff, applicable project instructions and any saved GitHub context. Identify the requested scope, inspect the relevant changes, and report concrete problems with file paths and line numbers. If the assigned checkout or necessary comparison commits are missing, explain what is needed.

Follow the selected agent's configured file permissions and the task. Do not assume that a review authorizes changes, publishing comments, or a merge.

Follow the result instructions in the assignment. Generic handoffs use the supplied `astack run finish` command to report the result, failure or need for input. For detailed findings, write a file in the checkout and attach it with `--artifact <relative-path>`. Reporting a result does not publish it to GitHub or clean up the checkout.
