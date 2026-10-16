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
] as const;
