/** SQL lives in compiled modules so the package allowlist includes every numbered migration. */
export const stateMigrations = [
  {
    version: 1,
    sql: `
CREATE TABLE state_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL
) STRICT;
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  common_directory TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.commonDirectory') IS common_directory)
) STRICT;
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  primary_checkout_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.primaryCheckoutId') IS primary_checkout_id),
  FOREIGN KEY(primary_checkout_id, id) REFERENCES checkouts(id, project_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  root_path TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.projectId') IS project_id)
    CHECK(json_extract(data, '$.repositoryId') IS repository_id)
    CHECK(json_extract(data, '$.rootPath') IS root_path),
  UNIQUE(id, project_id), UNIQUE(id, project_id, repository_id)
) STRICT;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.projectId') IS project_id)
    CHECK(json_extract(data, '$.repositoryId') IS repository_id)
    CHECK(json_extract(data, '$.checkoutId') IS checkout_id)
    CHECK(json_extract(data, '$.requester') IS requester)
    CHECK(json_extract(data, '$.operation') IS operation)
    CHECK(json_extract(data, '$.idempotencyKey') IS idempotency_key),
  UNIQUE(requester, project_id, operation, idempotency_key),
  FOREIGN KEY(checkout_id, project_id, repository_id) REFERENCES checkouts(id, project_id, repository_id)
) STRICT;
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  number INTEGER NOT NULL CHECK(number > 0),
  resolved_at INTEGER,
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.jobId') IS job_id) CHECK(json_extract(data, '$.number') IS number),
  UNIQUE(job_id, number)
) STRICT;
CREATE UNIQUE INDEX one_unresolved_attempt ON attempts(job_id) WHERE resolved_at IS NULL;
CREATE TABLE effects (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed', 'unknown', 'cancelled')),
  claim_owner TEXT,
  claim_token TEXT,
  claimed_at INTEGER,
  expires_at INTEGER,
  evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)),
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
    CHECK(json_extract(data, '$.kind') IS kind) CHECK(json_extract(data, '$.key') IS effect_key),
  UNIQUE(attempt_id, kind, effect_key),
  CHECK((claim_owner IS NULL AND claim_token IS NULL AND claimed_at IS NULL AND expires_at IS NULL)
    OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claimed_at IS NOT NULL
      AND expires_at IS NOT NULL AND claimed_at >= 0
      AND expires_at > claimed_at AND expires_at - claimed_at <= 30000)),
  CHECK((state = 'pending' AND evidence IS NULL)
    OR (state <> 'pending' AND evidence IS NOT NULL AND claim_token IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX unique_effect_claim_token ON effects(claim_token) WHERE claim_token IS NOT NULL;
CREATE TABLE results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
) STRICT;
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  released_at INTEGER,
  release_evidence TEXT CHECK(release_evidence IS NULL OR json_valid(release_evidence)),
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
    CHECK(json_extract(data, '$.kind') IS kind) CHECK(json_extract(data, '$.key') IS resource_key),
  CHECK((released_at IS NULL) = (release_evidence IS NULL))
) STRICT;
CREATE UNIQUE INDEX unique_retained_resource ON resources(kind, resource_key) WHERE released_at IS NULL;
CREATE INDEX effects_by_attempt ON effects(attempt_id);
CREATE INDEX resources_by_attempt ON resources(attempt_id);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE project_registrations (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id),
  registered_at INTEGER NOT NULL CHECK(registered_at >= 0),
  UNIQUE(project_id, repository_id)
) STRICT;
CREATE TABLE registered_checkouts (
  checkout_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  registered_at INTEGER NOT NULL CHECK(registered_at >= 0),
  location TEXT NOT NULL CHECK(json_valid(location)),
  FOREIGN KEY(checkout_id, project_id, repository_id) REFERENCES checkouts(id, project_id, repository_id),
  FOREIGN KEY(project_id, repository_id) REFERENCES project_registrations(project_id, repository_id)
) STRICT;
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE managed_worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  source_checkout_id TEXT NOT NULL,
  attempt_id TEXT REFERENCES attempts(id),
  owner_key TEXT NOT NULL,
  branch TEXT NOT NULL,
  checkout_path TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK(phase IN ('preparing', 'ready', 'removing', 'removed', 'abandoned')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  operation_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data))
    CHECK(json_extract(data, '$.intent.id') IS id)
    CHECK(json_extract(data, '$.intent.projectId') IS project_id)
    CHECK(json_extract(data, '$.intent.repositoryId') IS repository_id)
    CHECK(json_extract(data, '$.intent.sourceCheckoutId') IS source_checkout_id)
    CHECK(json_extract(data, '$.intent.run.id') IS attempt_id)
    CHECK(json_extract(data, '$.intent.key') IS owner_key)
    CHECK(json_extract(data, '$.intent.branch') IS branch)
    CHECK(json_extract(data, '$.intent.checkoutPath') IS checkout_path)
    CHECK(json_extract(data, '$.phase') IS phase)
    CHECK(json_extract(data, '$.revision') IS revision)
    CHECK(json_extract(data, '$.operationId') IS operation_id),
  UNIQUE(project_id, owner_key), UNIQUE(repository_id, branch),
  FOREIGN KEY(project_id, repository_id) REFERENCES project_registrations(project_id, repository_id),
  FOREIGN KEY(source_checkout_id, project_id, repository_id) REFERENCES checkouts(id, project_id, repository_id)
) STRICT;
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE service_entries (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  effect_id TEXT NOT NULL UNIQUE REFERENCES effects(id),
  role TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'dispatching', 'started', 'awaiting_result', 'blocked', 'unknown')),
  data TEXT NOT NULL CHECK(json_valid(data))
    CHECK(json_extract(data, '$.jobId') IS job_id)
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
    CHECK(json_extract(data, '$.effectId') IS effect_id)
    CHECK(json_extract(data, '$.role') IS role)
    CHECK(json_extract(data, '$.state') IS state)
) STRICT;
CREATE INDEX service_by_state ON service_entries(state, queued_at, job_id);
CREATE INDEX service_queue_order ON service_entries(queued_at, job_id);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE herdr_projects (
  project_id TEXT PRIMARY KEY REFERENCES project_registrations(project_id),
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.projectId') IS project_id)
) STRICT;
CREATE TABLE herdr_spaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES herdr_projects(project_id),
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  attempt_id TEXT UNIQUE REFERENCES attempts(id),
  kind TEXT NOT NULL CHECK(kind IN ('primary', 'worker')),
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.id') IS id)
    CHECK(json_extract(data, '$.projectId') IS project_id)
    CHECK(json_extract(data, '$.checkoutId') IS checkout_id)
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
    CHECK(json_extract(data, '$.kind') IS kind)
) STRICT;
CREATE UNIQUE INDEX one_herdr_primary ON herdr_spaces(project_id) WHERE kind='primary';
CREATE UNIQUE INDEX one_herdr_worker_checkout ON herdr_spaces(checkout_id) WHERE kind='worker';
`,
  },
  {
    version: 6,
    sql: `
CREATE TABLE runtime_sessions (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  job_id TEXT NOT NULL REFERENCES service_entries(job_id),
  effect_id TEXT NOT NULL UNIQUE REFERENCES effects(id),
  launch_id TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL UNIQUE REFERENCES herdr_spaces(id),
  data TEXT NOT NULL CHECK(json_valid(data))
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
    CHECK(json_extract(data, '$.jobId') IS job_id)
    CHECK(json_extract(data, '$.effectId') IS effect_id)
    CHECK(json_extract(data, '$.launchId') IS launch_id)
    CHECK(json_extract(data, '$.space.id') IS space_id)
) STRICT;
CREATE TABLE runtime_actions (
  attempt_id TEXT NOT NULL REFERENCES runtime_sessions(attempt_id),
  action_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'acknowledged')),
  data TEXT NOT NULL CHECK(json_valid(data))
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
    CHECK(json_extract(data, '$.key') IS action_key)
    CHECK(json_extract(data, '$.state') IS state),
  PRIMARY KEY(attempt_id, action_key)
) STRICT;
CREATE UNIQUE INDEX one_pending_runtime_action ON runtime_actions(attempt_id) WHERE state='pending';
`,
  },
  {
    version: 7,
    sql: `
CREATE TABLE review_requests (
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_key TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES service_entries(job_id),
  submission TEXT NOT NULL CHECK(json_valid(submission)),
  PRIMARY KEY(project_id, request_key)
) STRICT;
CREATE INDEX review_target_lookup ON jobs(project_id, repository_id,
  json_extract(data, '$.intent.task.submission.target.host'),
  json_extract(data, '$.intent.task.submission.target.repository'),
  json_extract(data, '$.intent.task.submission.target.number'),
  json_extract(data, '$.intent.task.submission.target.sha')) WHERE operation='delegate:reviewer';
`,
  },
  {
    version: 8,
    sql: `
CREATE TABLE run_controls (job_id TEXT PRIMARY KEY REFERENCES service_entries(job_id), data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE run_reports (job_id TEXT NOT NULL REFERENCES service_entries(job_id), report_key TEXT NOT NULL, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(job_id, report_key)) STRICT;
CREATE TABLE run_responses (job_id TEXT NOT NULL REFERENCES service_entries(job_id), response_key TEXT NOT NULL, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(job_id, response_key)) STRICT;
CREATE TABLE run_resumes (job_id TEXT NOT NULL REFERENCES service_entries(job_id), resume_key TEXT NOT NULL, response_id TEXT NOT NULL UNIQUE REFERENCES run_responses(id), state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(job_id, resume_key)) STRICT;
CREATE UNIQUE INDEX one_unsettled_resume ON run_resumes(job_id) WHERE state IN ('authorized','pending','unknown');
CREATE TABLE run_cancellations (job_id TEXT NOT NULL REFERENCES service_entries(job_id), cancel_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(job_id,cancel_key)) STRICT;
CREATE TABLE run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL REFERENCES service_entries(job_id), attempt_id TEXT NOT NULL REFERENCES attempts(id), data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE INDEX run_events_job ON run_events(job_id,id);
CREATE INDEX run_events_project ON run_events(project_id,id);
CREATE TABLE run_cursors (consumer TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(consumer,scope)) STRICT;
INSERT INTO run_events(project_id,job_id,attempt_id,data)
SELECT jobs.project_id, jobs.id, service_entries.attempt_id, json_object('projectId',jobs.project_id,'jobId',jobs.id,'attemptId',service_entries.attempt_id,'kind','baseline','createdAt',json_extract(jobs.data,'$.createdAt'),'detail',json_object('state',service_entries.state)) FROM jobs JOIN service_entries ON jobs.id=service_entries.job_id ORDER BY service_entries.queued_at,jobs.id;
`,
  },
  {
    version: 9,
    sql: `
CREATE TABLE runtime_input_retries (
  attempt_id TEXT NOT NULL REFERENCES runtime_sessions(attempt_id),
  action_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  data TEXT NOT NULL CHECK(json_valid(data))
    CHECK(json_extract(data, '$.attemptId') IS attempt_id)
    CHECK(json_extract(data, '$.key') IS action_key)
    CHECK(json_extract(data, '$.generation') IS generation),
  PRIMARY KEY(attempt_id, action_key, generation)
) STRICT;
`,
  },
  {
    version: 10,
    sql: `
CREATE TABLE run_reconciliations (
  job_id TEXT PRIMARY KEY REFERENCES service_entries(job_id),
  data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data, '$.request.jobId') IS job_id)
) STRICT;
`,
  },
  {
    version: 11,
    sql: `
CREATE TABLE implementation_handoffs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES service_entries(job_id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_key TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','accepted','abandoned')),
  data TEXT NOT NULL CHECK(json_valid(data))
    CHECK(json_extract(data,'$.id') IS id)
    CHECK(json_extract(data,'$.request.jobId') IS job_id)
    CHECK(json_extract(data,'$.source.projectId') IS project_id)
    CHECK(json_extract(data,'$.request.key') IS request_key)
    CHECK(json_extract(data,'$.phase') IS phase),
  UNIQUE(job_id, request_key)
) STRICT;
CREATE UNIQUE INDEX one_current_handoff ON implementation_handoffs(job_id) WHERE phase != 'abandoned';
CREATE INDEX handoff_followups ON implementation_handoffs(project_id,id) WHERE phase='accepted';
`,
  },
  {
    version: 12,
    sql: `
CREATE TABLE ci_targets (
 id TEXT PRIMARY KEY,
 next_refresh_at INTEGER NOT NULL,
 claim_expires_at INTEGER,
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.id') IS id)
 CHECK(json_extract(data,'$.nextRefreshAt') IS next_refresh_at)
 CHECK(json_extract(data,'$.claim.expiresAt') IS claim_expires_at)
) STRICT;
CREATE TABLE ci_requests (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 source_id TEXT NOT NULL,
 target_id TEXT NOT NULL REFERENCES ci_targets(id),
 phase TEXT NOT NULL CHECK(phase IN ('watching','ready','blocked','suspended','cancelled','completed')),
 deadline_at INTEGER NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.id') IS id)
 CHECK(json_extract(data,'$.binding.projectId') IS project_id)
 CHECK(json_extract(data,'$.binding.sourceId') IS source_id)
 CHECK(json_extract(data,'$.targetId') IS target_id)
 CHECK(json_extract(data,'$.phase') IS phase)
 CHECK(json_extract(data,'$.deadlineAt') IS deadline_at)
) STRICT;
CREATE UNIQUE INDEX ci_one_active_source ON ci_requests(project_id,source_id) WHERE phase='watching';
CREATE INDEX ci_subscribers ON ci_requests(target_id,phase);
CREATE INDEX ci_deadlines ON ci_requests(phase,deadline_at);
CREATE INDEX ci_due ON ci_targets(next_refresh_at,claim_expires_at);
CREATE TABLE ci_budgets (
 host TEXT PRIMARY KEY,
 window_started_at INTEGER NOT NULL CHECK(window_started_at>=0),
 window_ends_at INTEGER NOT NULL CHECK(window_ends_at>window_started_at),
 used INTEGER NOT NULL CHECK(used>=0),
 capacity INTEGER NOT NULL CHECK(capacity>=0),
 not_before INTEGER NOT NULL CHECK(not_before>=0)
) STRICT;
`,
  },
  {
    version: 13,
    sql: `
CREATE TABLE review_automation (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.projectId') IS project_id)
) STRICT;
CREATE TABLE review_follow_ups (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 follow_up_id TEXT NOT NULL UNIQUE,
 phase TEXT NOT NULL CHECK(phase IN ('waiting','queued','suspended','blocked','dispatched','satisfied','cancelled')),
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.id') IS id)
 CHECK(json_extract(data,'$.projectId') IS project_id)
 CHECK(json_extract(data,'$.followUpId') IS follow_up_id)
 CHECK(json_extract(data,'$.phase') IS phase)
) STRICT;
CREATE INDEX automatic_review_queue ON review_follow_ups(phase,id);
`,
  },
  {
    version: 14,
    sql: `
CREATE TABLE review_result_observations (
 report_id TEXT PRIMARY KEY REFERENCES run_reports(id),
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.reportId') IS report_id)
) STRICT;
CREATE TABLE review_result_publications (
 id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES service_entries(job_id),
 report_key TEXT NOT NULL,
 report_id TEXT NOT NULL UNIQUE REFERENCES run_reports(id),
 request_key TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.id') IS id)
 CHECK(json_extract(data,'$.request.jobId') IS job_id)
 CHECK(json_extract(data,'$.request.reportKey') IS report_key)
 CHECK(json_extract(data,'$.request.reportId') IS report_id)
 CHECK(json_extract(data,'$.request.key') IS request_key),
 UNIQUE(job_id,report_key,request_key),
 FOREIGN KEY(job_id,report_key) REFERENCES run_reports(job_id,report_key)
) STRICT;
`,
  },
  {
    version: 15,
    sql: `
CREATE TABLE cleanup_plans (
 job_id TEXT PRIMARY KEY REFERENCES service_entries(job_id),
 id TEXT NOT NULL UNIQUE,
 checkout_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('requested','started','blocked','suspended','completed','cancelled')),
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.id') IS id)
 CHECK(json_extract(data,'$.request.jobId') IS job_id)
 CHECK(json_extract(data,'$.checkoutId') IS checkout_id)
 CHECK(json_extract(data,'$.phase') IS phase)
) STRICT;
CREATE UNIQUE INDEX cleanup_one_checkout ON cleanup_plans(checkout_id);
CREATE INDEX cleanup_queue ON cleanup_plans(phase,job_id);
`,
  },
  {
    version: 16,
    sql: `
CREATE TABLE resource_allocations (
 id TEXT PRIMARY KEY REFERENCES resources(id),
 job_id TEXT NOT NULL REFERENCES service_entries(job_id),
 attempt_id TEXT NOT NULL REFERENCES attempts(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 request_key TEXT NOT NULL,
 allocation_key TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('probing','reserved','blocked','starting','running','retained','released')),
 revision INTEGER NOT NULL CHECK(revision>=0),
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.id') IS id)
 CHECK(json_extract(data,'$.request.jobId') IS job_id)
 CHECK(json_extract(data,'$.request.attemptId') IS attempt_id)
 CHECK(json_extract(data,'$.binding.projectId') IS project_id)
 CHECK(json_extract(data,'$.request.key') IS request_key)
 CHECK(json_extract(data,'$.phase') IS phase)
 CHECK(json_extract(data,'$.revision') IS revision),
 UNIQUE(attempt_id,request_key)
) STRICT;
CREATE UNIQUE INDEX one_active_allocation ON resource_allocations(allocation_key) WHERE phase!='released';
CREATE INDEX allocations_project ON resource_allocations(project_id,id);
CREATE TRIGGER allocation_release_guard BEFORE UPDATE OF released_at ON resources
 WHEN NEW.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM resource_allocations WHERE id=NEW.id AND phase!='released')
 BEGIN SELECT RAISE(ABORT, 'allocation requires verified release'); END;
`,
  },
  {
    version: 17,
    sql: `
CREATE TABLE hook_invocations (
 id TEXT PRIMARY KEY REFERENCES resources(id),
 job_id TEXT NOT NULL REFERENCES service_entries(job_id),
 attempt_id TEXT NOT NULL REFERENCES attempts(id),
 checkout_id TEXT NOT NULL REFERENCES checkouts(id),
 request_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','executing','succeeded','failed','cancelled','unknown')),
 revision INTEGER NOT NULL CHECK(revision>=0),
 data TEXT NOT NULL CHECK(json_valid(data)) CHECK(json_extract(data,'$.id') IS id)
 CHECK(json_extract(data,'$.request.jobId') IS job_id)
 CHECK(json_extract(data,'$.request.attemptId') IS attempt_id)
 CHECK(json_extract(data,'$.binding.checkoutId') IS checkout_id)
 CHECK(json_extract(data,'$.request.key') IS request_key)
 CHECK(json_extract(data,'$.status') IS status)
 CHECK(json_extract(data,'$.revision') IS revision),
 UNIQUE(attempt_id,request_key)
) STRICT;
CREATE UNIQUE INDEX one_hook_writer ON hook_invocations(checkout_id) WHERE status IN ('prepared','executing');
CREATE TRIGGER hook_release_guard BEFORE UPDATE OF released_at ON resources
 WHEN NEW.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM hook_invocations WHERE id=NEW.id AND json_extract(data,'$.shutdown') IS NULL)
 BEGIN SELECT RAISE(ABORT, 'hook requires verified shutdown'); END;
`,
  },
] as const;
