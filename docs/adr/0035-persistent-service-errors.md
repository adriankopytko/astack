# ADR 0035: Persist service errors for inspection

Record normalized errors returned by the local service and asynchronous worker dispatch blockers, uncertain observations, failed reports and failed after-hooks in private SQLite state. Each record has an opaque ID, timestamp, operation, optional project/job identity, code and bounded message. Do not retain task text, process output, environment values, credentials or arbitrary transcripts in this log.

Queue blockers, uncertain observations and failed reports are recorded in their existing state transactions. Service response failures and after-hook failures are recorded separately without turning logging failure into authority to retry the underlying operation. `astack errors list` and `astack errors inspect` read existing state without starting the coordinator. Failures before a request reaches the service are reported directly and are not recorded by this mechanism.
