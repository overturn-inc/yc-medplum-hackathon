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

/** Re-exported for callers that want a raw `CURRENT_TIMESTAMP`-style default without drifting from SQL. */
export const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
