-- Session-scoped durable repository schema (D1 / SQLite).
-- Non-destructive: every statement is guarded with IF NOT EXISTS so this
-- migration is safe to re-run against an existing database.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  updated_at TEXT,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS events_session_id_idx ON events (session_id);

CREATE TABLE IF NOT EXISTS action_reservations (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  client_request_id TEXT,
  episode_id TEXT,
  action_type TEXT,
  status TEXT,
  receipt_id TEXT,
  created_at TEXT,
  UNIQUE (session_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS action_reservations_session_id_idx ON action_reservations (session_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  episode_id TEXT,
  updated_at TEXT,
  UNIQUE (session_id, episode_id)
);

CREATE INDEX IF NOT EXISTS conversations_session_id_idx ON conversations (session_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  role TEXT,
  content TEXT,
  intent TEXT,
  citations_json TEXT,
  created_at TEXT,
  client_request_id TEXT,
  proposal_id TEXT
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_id_idx ON conversation_messages (conversation_id);

CREATE TABLE IF NOT EXISTS episode_thread_bindings (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  episode_id TEXT,
  thread_id TEXT,
  UNIQUE (session_id, episode_id)
);

CREATE INDEX IF NOT EXISTS episode_thread_bindings_session_id_idx ON episode_thread_bindings (session_id);
