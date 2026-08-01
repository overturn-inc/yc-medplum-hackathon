-- Additive tool-job, ordered progress, connector-receipt, and rate-limit tables.
-- Non-destructive: every statement is guarded with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS tool_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_revision INTEGER NOT NULL,
  episode_id TEXT NOT NULL,
  episode_revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  connector_receipt_json TEXT,
  proof_refs_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS tool_jobs_session_id_idx ON tool_jobs (session_id);
CREATE INDEX IF NOT EXISTS tool_jobs_session_status_idx ON tool_jobs (session_id, status);

CREATE TABLE IF NOT EXISTS tool_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  proof_ref TEXT,
  UNIQUE (job_id, seq)
);

CREATE INDEX IF NOT EXISTS tool_job_events_job_id_idx ON tool_job_events (job_id);
CREATE INDEX IF NOT EXISTS tool_job_events_session_id_idx ON tool_job_events (session_id);

CREATE TABLE IF NOT EXISTS connector_receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  job_id TEXT,
  episode_id TEXT NOT NULL,
  action TEXT NOT NULL,
  provider TEXT NOT NULL,
  confirmation TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, id)
);

CREATE INDEX IF NOT EXISTS connector_receipts_session_episode_idx
  ON connector_receipts (session_id, episode_id);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  UNIQUE (scope, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_windows_scope_idx ON rate_limit_windows (scope);
