# ADR 0029: Save configuration for each job

Status: Accepted

The primary checkout remains the single editable source of project configuration. Astack reads it when it accepts a job and saves the accepted configuration in the private local database in the same transaction as the job. Existing jobs use their saved settings; new jobs use the current file. Project edits do not by themselves prevent worker launch, input, interruption or the job's own verification.

The snapshot currently contains the complete project configuration, including command arguments and launch profiles. It is not returned through ordinary job inspection. Credentials and secret environment values must never be placed in project configuration or command arguments. Explicitly configured nonsecret launch-profile paths are retained; ambient environment values and executable contents are not captured. Existing jobs lacking a saved configuration must be resubmitted; the mutable project file is never used as a replacement for a missing snapshot.

Verification for an existing job currently uses that job's accepted verification settings. After-handoff CI watches bind review-gate settings rather than unrelated role configuration; the reviewer reads the then-current file when its job is accepted. Provider identity, checkout ownership, actual prerequisites, report validation and uncertainty handling remain independent.

This supersedes the configuration-drift blocking parts of ADR 0028 and earlier configuration contracts.
