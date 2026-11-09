# ADR 0036: Queue worker tasks before setup

Implementation and manual-review submissions first persist a task request and its project configuration snapshot. They return the stable job ID and queued state before creating a worktree, Herdr workspace, or hook. Queue inspection and cancellation are available using the normal job ID. Queue records and saved settings live in private SQLite state.

The coordinator reserves global and agent capacity transactionally before preparing a worker. Preparing and prepared reservations count against both capacity limits. Once the job and checkout are accepted, the same transaction records the prepared state; a subsequent worker claim transfers the reservation into ordinary active capacity atomically. Tasks without a compatible runtime are rejected before acceptance. Existing claimed/unknown workers and interrupted preparations retain capacity.

At dispatch the worker uses the configuration captured at task acceptance, while implementation base selection fetches current `origin/main` unless an explicit or review-fix base was saved. A queued cancellation creates no worker. An interrupted preparation is never replayed automatically. After explicit writer-excluded worktree reconciliation verifies a ready checkout, the task returns to the queue; verified absence blocks it without creating a replacement automatically.

Existing accepted jobs and automatic review follow-ups retain their established contracts. Worker queue state before a job exists is inspected through `implement inspect`, `review inspect`, or `run inspect`; run events begin when the job is accepted after preparation.

Cancellation is available while a request is queued or blocked; a request already preparing must first complete preparation or be reconciled. If the coordinator stops after reserving capacity but before recording a worktree intent, the reservation remains held and there is currently no command to reconcile that particular interruption. Do not infer that the original preparation stopped or create a replacement from the absence of a worktree record.
