# ADR 0033: Create worker checkouts with Herdr

Worker submissions prepare their own dedicated checkout and grouped Herdr workspace using `herdr worktree create`. The service saves an owned worktree intent before the provider call, verifies the exact checkout and workspace afterward, and saves the workspace receipt before accepting the job. The runtime binds that receipt; it never reopens a checkout. Port environment is supplied to a tab in the saved workspace.

The task key binds the implementation branch and base. Reviews use a generated local `code-review` branch at the exact PR head; matching non-repeat review requests share their checkout. A missing PR commit is fetched from the explicitly selected PR and revalidated before review acceptance. Project configuration is checked before setup and saved with the accepted job.

An interrupted creation is not retried automatically. After the original writer has stopped, an operation-bound reconciliation inspects the saved workspace intent, exact Herdr server, checkout and Git state before settling it. Cleanup remains a separate opt-in operation. After an owned reviewer checkout is removed, cleanup deletes only its unchanged generated local review branch using a compare-and-delete operation. Implementation and remote branches are retained. An uncertain deletion keeps the cleanup claim for explicit reconciliation.

This decision changes worker setup, not the later implementation-to-review workflow. Report collection, publication, review follow-up and cleanup enrollment retain their existing explicit contracts.
