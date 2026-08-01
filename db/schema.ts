/**
 * Drizzle schema for the session-scoped durable repository (D1 / SQLite).
 *
 * Mirrors `db/migrations/0001_init.sql`. Keep both in sync by hand: this file
 * is the typed query surface, the migration is the source of truth for the
 * actual database shape applied via `drizzle-kit` / D1 migrations.
 */
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

/** One row per demo session (cookie-scoped). `snapshot_json` is the latest DemoSnapshot cache. */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
});

/** Append-only domain event ledger, scoped per session and ordered by `seq`. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => [
    uniqueIndex("events_session_seq_unique").on(table.sessionId, table.seq),
    index("events_session_id_idx").on(table.sessionId),
  ],
);

/**
 * Idempotency ledger for agent-executed actions. `UNIQUE(session_id, client_request_id)`
 * guarantees a client-generated retry never double-executes an approved action.
 */
export const actionReservations = sqliteTable(
  "action_reservations",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    clientRequestId: text("client_request_id"),
    episodeId: text("episode_id"),
    actionType: text("action_type"),
    status: text("status"),
    receiptId: text("receipt_id"),
    createdAt: text("created_at"),
  },
  (table) => [
    uniqueIndex("action_reservations_session_request_unique").on(
      table.sessionId,
      table.clientRequestId,
    ),
    index("action_reservations_session_id_idx").on(table.sessionId),
  ],
);

/** One conversation thread per (session, episode). */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    episodeId: text("episode_id"),
    updatedAt: text("updated_at"),
  },
  (table) => [
    uniqueIndex("conversations_session_episode_unique").on(
      table.sessionId,
      table.episodeId,
    ),
    index("conversations_session_id_idx").on(table.sessionId),
  ],
);

/** Ordered chat turns for a conversation. */
export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id"),
    role: text("role"),
    content: text("content"),
    intent: text("intent"),
    citationsJson: text("citations_json"),
    createdAt: text("created_at"),
    clientRequestId: text("client_request_id"),
    proposalId: text("proposal_id"),
  },
  (table) => [
    index("conversation_messages_conversation_id_idx").on(table.conversationId),
  ],
);

/** Binds an episode's agent conversation to an external (e.g. BFF) thread id, per session. */
export const episodeThreadBindings = sqliteTable(
  "episode_thread_bindings",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    episodeId: text("episode_id"),
    threadId: text("thread_id"),
  },
  (table) => [
    uniqueIndex("episode_thread_bindings_session_episode_unique").on(
      table.sessionId,
      table.episodeId,
    ),
    index("episode_thread_bindings_session_id_idx").on(table.sessionId),
  ],
);

/** Async tool jobs (browser/voice) scoped per session with revision fencing. */
export const toolJobs = sqliteTable(
  "tool_jobs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    sessionRevision: integer("session_revision").notNull(),
    episodeId: text("episode_id").notNull(),
    episodeRevision: integer("episode_revision").notNull(),
    action: text("action").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    progressJson: text("progress_json").notNull(),
    resultJson: text("result_json"),
    errorJson: text("error_json"),
    connectorReceiptJson: text("connector_receipt_json"),
    proofRefsJson: text("proof_refs_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tool_jobs_session_idempotency_unique").on(
      table.sessionId,
      table.idempotencyKey,
    ),
    index("tool_jobs_session_id_idx").on(table.sessionId),
    index("tool_jobs_session_status_idx").on(table.sessionId, table.status),
  ],
);

/** Ordered progress events for a tool job. */
export const toolJobEvents = sqliteTable(
  "tool_job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    phase: text("phase").notNull(),
    message: text("message").notNull(),
    proofRef: text("proof_ref"),
  },
  (table) => [
    uniqueIndex("tool_job_events_job_seq_unique").on(table.jobId, table.seq),
    index("tool_job_events_job_id_idx").on(table.jobId),
    index("tool_job_events_session_id_idx").on(table.sessionId),
  ],
);

/** Durable connector receipts that alone may advance hero/external state. */
export const connectorReceipts = sqliteTable(
  "connector_receipts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    jobId: text("job_id"),
    episodeId: text("episode_id").notNull(),
    action: text("action").notNull(),
    provider: text("provider").notNull(),
    confirmation: text("confirmation"),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("connector_receipts_session_id_unique").on(
      table.sessionId,
      table.id,
    ),
    index("connector_receipts_session_episode_idx").on(
      table.sessionId,
      table.episodeId,
    ),
  ],
);

/**
 * Rate-limit windows that survive session reset so public abuse controls
 * cannot be erased by demo reset.
 */
export const rateLimitWindows = sqliteTable(
  "rate_limit_windows",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    windowStart: text("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    uniqueIndex("rate_limit_windows_scope_window_unique").on(
      table.scope,
      table.windowStart,
    ),
    index("rate_limit_windows_scope_idx").on(table.scope),
  ],
);

/** Re-exported for callers that want a raw `CURRENT_TIMESTAMP`-style default without drifting from SQL. */
export const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
