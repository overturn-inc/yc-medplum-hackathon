/**
 * Local SQLite SessionRepository for Node tests only (better-sqlite3).
 *
 * The public Sites/Worker runtime uses `D1SessionRepository` in
 * `d1-repository.ts` against the Cloudflare `env.DB` binding. Do not import
 * this module from Worker entry paths.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getDemoClock } from "@/domain/clock";
import { parseDomainEvent, parseDemoSnapshot } from "@/domain/schemas";
import type {
  ClaimEpisode,
  ConversationMessage,
  DemoSnapshot,
  DomainEvent,
} from "@/domain/types";
import {
  createInitialSnapshot,
  rehydrateEpisode,
  StoreDegradedError,
  type StoreOptions,
} from "@/server/store";
import type {
  ApprovalConsumedEvent,
  SessionRepository,
} from "@/server/repository";

function migrationSql(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "db", "migrations", "0001_init.sql"),
    "utf8",
  );
}

export function openSqliteDatabase(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.exec(migrationSql());
  return db;
}

export class SqliteSessionRepository implements SessionRepository {
  readonly sessionId: string;
  private readonly db: Database.Database;
  private readonly healthcareMode: StoreOptions["healthcareMode"];
  private readonly agentMode: StoreOptions["agentMode"];
  private snapshot: DemoSnapshot;
  private executionIndex = new Map<string, string>();
  private pendingEvents: DomainEvent[] = [];
  private dirtyEpisodeIds = new Set<string>();
  private degraded: { reason: string; recovery: string } | null = null;
  private mutating = false;
  private nextSeq = 1;
  /** Process-local mutation lock tail; see `withMutationLock`. A durable D1/SQL
   * deployment additionally relies on `reserveAction`'s unique constraint for
   * cross-process idempotency, since this in-memory chain only serializes
   * callers within a single process. */
  private mutationLockTail: Promise<unknown> = Promise.resolve();

  constructor(
    sessionId: string,
    db: Database.Database,
    options: StoreOptions = {},
  ) {
    this.sessionId = sessionId;
    this.db = db;
    this.healthcareMode = options.healthcareMode ?? "local";
    this.agentMode = options.agentMode ?? "synthetic";
    this.snapshot = this.loadOrSeed();
  }

  private rebuildExecutionIndex(events: DomainEvent[]): void {
    this.executionIndex.clear();
    for (const event of events) {
      if (event.type === "approval.consumed" && event.receiptId) {
        this.executionIndex.set(event.idempotencyKey, event.receiptId);
      } else if (
        (event.type === "claim.submitted" ||
          event.type === "reprocessing.requested" ||
          event.type === "status.refreshed" ||
          event.type === "claim.corrected_resubmitted" ||
          event.type === "documentation.sent") &&
        "idempotencyKey" in event &&
        "receiptId" in event
      ) {
        this.executionIndex.set(
          event.idempotencyKey,
          (event as { receiptId: string }).receiptId,
        );
      }
    }
  }

  private loadEvents(): DomainEvent[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(this.sessionId) as Array<{ payload_json: string }>;
    return rows.map((row, index) => {
      try {
        return parseDomainEvent(JSON.parse(row.payload_json));
      } catch (error) {
        throw new StoreDegradedError(
          `Corrupt D1 event at seq index ${index + 1}: ${
            error instanceof Error ? error.message : "invalid"
          }`,
          "Use Reset demo to quarantine the corrupt ledger and restore the synthetic seed projection.",
        );
      }
    });
  }

  private persistSnapshot(snapshot: DemoSnapshot): void {
    const now = getDemoClock();
    this.db
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at, snapshot_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, snapshot_json = excluded.snapshot_json`,
      )
      .run(this.sessionId, now, now, JSON.stringify(snapshot));
  }

  private appendPersisted(events: DomainEvent[]): void {
    const insert = this.db.prepare(
      `INSERT INTO events (id, session_id, seq, at, type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((batch: DomainEvent[]) => {
      for (const event of batch) {
        insert.run(
          event.id,
          this.sessionId,
          this.nextSeq,
          event.at,
          event.type,
          JSON.stringify(event),
        );
        this.nextSeq += 1;
      }
    });
    tx(events);
  }

  private loadOrSeed(): DemoSnapshot {
    try {
      const maxSeq = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE session_id = ?`,
        )
        .get(this.sessionId) as { max_seq: number };
      this.nextSeq = (maxSeq?.max_seq ?? 0) + 1;

      const events = this.loadEvents();
      if (events.length > 0) {
        // Replay from last reset boundary using projected episodes.
        let start = 0;
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (events[i]?.type === "demo.session.reset") {
            start = i;
            break;
          }
        }
        const boundary = events[start];
        if (!boundary || boundary.type !== "demo.session.reset") {
          throw new StoreDegradedError(
            "Event ledger missing reset boundary",
            "Use Reset demo to restore a healthy synthetic seed projection.",
          );
        }
        let snapshot = createInitialSnapshot({
          healthcareMode: this.healthcareMode,
          agentMode: this.agentMode,
        });
        snapshot.sessionRevision = boundary.sessionRevision;
        snapshot.events = [boundary];
        for (let i = start + 1; i < events.length; i += 1) {
          const event = events[i]!;
          if (event.type === "episode.projected") {
            const episodes = snapshot.episodes.map((episode) =>
              episode.id === event.episodeId
                ? rehydrateEpisode(structuredClone(event.episode))
                : episode,
            );
            const exists = episodes.some((e) => e.id === event.episodeId);
            snapshot = {
              ...snapshot,
              episodes: exists
                ? episodes
                : [
                    ...episodes,
                    rehydrateEpisode(structuredClone(event.episode)),
                  ],
              events: [...snapshot.events, event],
            };
          } else {
            snapshot = {
              ...snapshot,
              events: [...snapshot.events, event],
            };
          }
        }
        snapshot.episodes = snapshot.episodes.map(rehydrateEpisode);
        this.rebuildExecutionIndex(snapshot.events);
        this.degraded = null;
        this.persistSnapshot(snapshot);
        return snapshot;
      }

      const fresh = createInitialSnapshot({
        healthcareMode: this.healthcareMode,
        agentMode: this.agentMode,
      });
      const boundary: DomainEvent = {
        ...fresh.events[0]!,
        id: `event-seed-${this.sessionId}-1`,
      };
      const seedEvents: DomainEvent[] = [
        boundary,
        ...fresh.episodes.map(
          (episode, index): DomainEvent => ({
            type: "episode.projected",
            id: `event-seed-episode-${this.sessionId}-${index + 1}`,
            at: getDemoClock(),
            episodeId: episode.id,
            schemaVersion: 1,
            episode: structuredClone(episode),
          }),
        ),
      ];
      fresh.events = seedEvents;
      this.appendPersisted(seedEvents);
      this.persistSnapshot(fresh);
      this.rebuildExecutionIndex(fresh.events);
      this.degraded = null;
      return fresh;
    } catch (error) {
      const reason =
        error instanceof StoreDegradedError
          ? error.message
          : error instanceof Error
            ? `Corrupt D1 demo store: ${error.message}`
            : "Corrupt D1 demo store";
      const recovery =
        error instanceof StoreDegradedError
          ? error.recovery
          : "Use Reset demo to restore the synthetic seed projection.";
      this.degraded = { reason, recovery };
      const degradedSnap = createInitialSnapshot({
        healthcareMode: this.healthcareMode,
        agentMode: this.agentMode,
      });
      degradedSnap.degraded = this.degraded;
      return degradedSnap;
    }
  }

  getDegraded() {
    return this.degraded;
  }

  getSnapshot(): DemoSnapshot {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    return structuredClone(this.snapshot);
  }

  getSnapshotUnsafe(): DemoSnapshot {
    return structuredClone(this.snapshot);
  }

  getEpisode(id: string): ClaimEpisode | undefined {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    return this.snapshot.episodes.find((e) => e.id === id);
  }

  beginMutation(): void {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.mutating = true;
  }

  abortMutation(): void {
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.mutating = false;
    if (!this.degraded) {
      this.snapshot = this.loadOrSeed();
    }
  }

  appendEvent(event: DomainEvent): void {
    parseDomainEvent(event);
    this.pendingEvents.push(event);
    this.snapshot.events.push(event);
  }

  replaceEpisode(episode: ClaimEpisode): void {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    const index = this.snapshot.episodes.findIndex((e) => e.id === episode.id);
    if (index < 0) throw new Error(`Unknown episode ${episode.id}`);
    this.snapshot.episodes[index] = rehydrateEpisode(episode);
    this.dirtyEpisodeIds.add(episode.id);
  }

  commit(): DemoSnapshot {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    for (const episodeId of this.dirtyEpisodeIds) {
      const episode = this.snapshot.episodes.find((e) => e.id === episodeId);
      if (!episode) continue;
      const projected: DomainEvent = {
        type: "episode.projected",
        id: `event-projected-${episodeId}-${getDemoClock()}-${Math.random().toString(36).slice(2, 7)}`,
        at: getDemoClock(),
        episodeId,
        schemaVersion: 1,
        episode: structuredClone(episode),
      };
      parseDomainEvent(projected);
      this.pendingEvents.push(projected);
      this.snapshot.events.push(projected);
    }
    this.dirtyEpisodeIds.clear();
    const toAppend = [...this.pendingEvents];
    this.pendingEvents = [];
    this.appendPersisted(toAppend);
    this.persistSnapshot(this.snapshot);
    this.rebuildExecutionIndex(this.snapshot.events);
    this.mutating = false;
    return structuredClone(this.snapshot);
  }

  getExecutionReceipt(idempotencyKey: string): string | undefined {
    return this.executionIndex.get(idempotencyKey);
  }

  withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationLockTail.then(fn, fn);
    this.mutationLockTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  findApprovalConsumed(input: {
    episodeId: string;
    actionType: string;
  }): ApprovalConsumedEvent | undefined {
    for (let i = this.snapshot.events.length - 1; i >= 0; i -= 1) {
      const event = this.snapshot.events[i];
      if (
        event?.type === "approval.consumed" &&
        event.episodeId === input.episodeId &&
        event.actionType === input.actionType
      ) {
        return event;
      }
    }
    return undefined;
  }

  rememberExecution(idempotencyKey: string, receiptId: string): void {
    this.executionIndex.set(idempotencyKey, receiptId);
    this.db
      .prepare(
        `UPDATE action_reservations
         SET status = 'completed', receipt_id = ?
         WHERE session_id = ? AND client_request_id = ?`,
      )
      .run(receiptId, this.sessionId, idempotencyKey);
  }

  reset(): DemoSnapshot {
    this.mutating = false;
    const nextRevision = (this.snapshot.sessionRevision || 1) + 1;
    const boundary: DomainEvent = {
      type: "demo.session.reset",
      id: `event-reset-${nextRevision}`,
      at: getDemoClock(),
      sessionRevision: nextRevision,
    };
    if (this.degraded) {
      this.db
        .prepare(`DELETE FROM events WHERE session_id = ?`)
        .run(this.sessionId);
      this.nextSeq = 1;
      this.degraded = null;
    }
    const fresh = createInitialSnapshot({
      healthcareMode: this.healthcareMode,
      agentMode: this.agentMode,
    });
    fresh.sessionRevision = nextRevision;
    const projected: DomainEvent[] = fresh.episodes.map(
      (episode, index): DomainEvent => ({
        type: "episode.projected",
        id: `event-reset-episode-${nextRevision}-${index + 1}`,
        at: getDemoClock(),
        episodeId: episode.id,
        schemaVersion: 1,
        episode: structuredClone(episode),
      }),
    );
    const seed = [boundary, ...projected];
    this.appendPersisted(seed);
    fresh.events = seed;
    fresh.degraded = null;
    this.executionIndex.clear();
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.snapshot = fresh;
    this.persistSnapshot(this.snapshot);
    this.rebuildExecutionIndex(this.snapshot.events);
    return structuredClone(this.snapshot);
  }

  async reserveAction(input: {
    clientRequestId: string;
    episodeId: string;
    actionType: string;
  }): Promise<{ reserved: boolean; existingReceiptId?: string }> {
    const existing = this.db
      .prepare(
        `SELECT receipt_id, status FROM action_reservations
         WHERE session_id = ? AND client_request_id = ?`,
      )
      .get(this.sessionId, input.clientRequestId) as
      | { receipt_id: string | null; status: string }
      | undefined;
    if (existing) {
      return {
        reserved: false,
        existingReceiptId: existing.receipt_id ?? undefined,
      };
    }
    this.db
      .prepare(
        `INSERT INTO action_reservations
         (id, session_id, client_request_id, episode_id, action_type, status, receipt_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'reserved', NULL, ?)`,
      )
      .run(
        `reservation-${input.clientRequestId}`,
        this.sessionId,
        input.clientRequestId,
        input.episodeId,
        input.actionType,
        getDemoClock(),
      );
    return { reserved: true };
  }

  async saveConversation(
    episodeId: string,
    messages: ConversationMessage[],
  ): Promise<void> {
    const conversationId = `${this.sessionId}:${episodeId}`;
    this.db
      .prepare(
        `INSERT INTO conversations (id, session_id, episode_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(conversationId, this.sessionId, episodeId, getDemoClock());
    this.db
      .prepare(`DELETE FROM conversation_messages WHERE conversation_id = ?`)
      .run(conversationId);
    const insert = this.db.prepare(
      `INSERT INTO conversation_messages
       (id, conversation_id, role, content, intent, citations_json, created_at, client_request_id, proposal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((batch: ConversationMessage[]) => {
      for (const message of batch) {
        insert.run(
          message.id,
          conversationId,
          message.role,
          message.content,
          message.intent,
          JSON.stringify(message.citations),
          message.createdAt,
          message.clientRequestId ?? null,
          message.proposalId ?? null,
        );
      }
    });
    tx(messages);
  }

  async loadConversation(episodeId: string): Promise<ConversationMessage[]> {
    const conversationId = `${this.sessionId}:${episodeId}`;
    const rows = this.db
      .prepare(
        `SELECT id, role, content, intent, citations_json, created_at, client_request_id, proposal_id
         FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
      )
      .all(conversationId) as Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      intent: ConversationMessage["intent"];
      citations_json: string;
      created_at: string;
      client_request_id: string | null;
      proposal_id: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      episodeId,
      role: row.role,
      content: row.content,
      intent: row.intent,
      citations: JSON.parse(row.citations_json),
      createdAt: row.created_at,
      clientRequestId: row.client_request_id ?? undefined,
      proposalId: row.proposal_id ?? undefined,
    }));
  }

  async bindThread(episodeId: string, threadId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO episode_thread_bindings (id, session_id, episode_id, thread_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id`,
      )
      .run(`${this.sessionId}:${episodeId}`, this.sessionId, episodeId, threadId);
  }

  async getThreadBinding(episodeId: string): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT thread_id FROM episode_thread_bindings
         WHERE session_id = ? AND episode_id = ?`,
      )
      .get(this.sessionId, episodeId) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }
}

export function createSqliteSessionRepository(
  sessionId: string,
  options?: StoreOptions & { filename?: string },
): SqliteSessionRepository {
  const db = openSqliteDatabase(options?.filename ?? ":memory:");
  return new SqliteSessionRepository(sessionId, db, options);
}

/** Helper for tests that need to assert a round-tripped snapshot parses. */
export function assertSnapshotParsable(snapshot: DemoSnapshot): DemoSnapshot {
  return parseDemoSnapshot(snapshot);
}
