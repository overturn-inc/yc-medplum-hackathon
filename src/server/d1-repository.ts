/**
 * Cloudflare D1-backed SessionRepository for the vinext Worker / Sites runtime.
 *
 * Uses the Workers `D1Database` binding exclusively. This module must never
 * import `better-sqlite3` or `node:fs` — those belong only in the local test
 * adapter (`sqlite-session-repository.ts`).
 */
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

/** Minimal D1 surface used by this repository (avoids requiring workers-types at typecheck). */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<Array<{ success: boolean; results?: T[] }>>;
  exec?(query: string): Promise<unknown>;
}

type GlobalD1Registry = {
  __harborviewD1SessionRegistry?: Map<string, D1SessionRepository>;
};

function d1Registry(): Map<string, D1SessionRepository> {
  const g = globalThis as unknown as GlobalD1Registry;
  if (!g.__harborviewD1SessionRegistry) {
    g.__harborviewD1SessionRegistry = new Map();
  }
  return g.__harborviewD1SessionRegistry;
}

export class D1SessionRepository implements SessionRepository {
  readonly sessionId: string;
  private readonly db: D1DatabaseLike;
  private readonly healthcareMode: NonNullable<StoreOptions["healthcareMode"]>;
  private readonly agentMode: NonNullable<StoreOptions["agentMode"]>;
  private snapshot: DemoSnapshot;
  private executionIndex = new Map<string, string>();
  private pendingEvents: DomainEvent[] = [];
  private dirtyEpisodeIds = new Set<string>();
  private degraded: { reason: string; recovery: string } | null = null;
  private mutating = false;
  private nextSeq = 1;
  private mutationLockTail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;

  constructor(
    sessionId: string,
    db: D1DatabaseLike,
    options: StoreOptions = {},
  ) {
    this.sessionId = sessionId;
    this.db = db;
    this.healthcareMode = options.healthcareMode ?? "local";
    this.agentMode = options.agentMode ?? "synthetic";
    this.snapshot = createInitialSnapshot({
      healthcareMode: this.healthcareMode,
      agentMode: this.agentMode,
    });
    this.ready = this.loadOrSeed()
      .then((snapshot) => {
        this.snapshot = snapshot;
      })
      .catch((error) => {
        this.snapshot = this.degradedSnapshot(error);
      });
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
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

  private degradedSnapshot(error: unknown): DemoSnapshot {
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

  private async loadEvents(): Promise<DomainEvent[]> {
    const result = await this.db
      .prepare(
        `SELECT payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .bind(this.sessionId)
      .all<{ payload_json: string }>();
    return (result.results ?? []).map((row, index) => {
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

  private async persistSnapshot(snapshot: DemoSnapshot): Promise<void> {
    const now = getDemoClock();
    await this.db
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at, snapshot_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, snapshot_json = excluded.snapshot_json`,
      )
      .bind(this.sessionId, now, now, JSON.stringify(snapshot))
      .run();
  }

  private async appendPersisted(events: DomainEvent[]): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    for (const event of events) {
      const storageId = `${this.sessionId}:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}:${event.id}`;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO events (id, session_id, seq, at, type, payload_json)
             SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
             FROM events WHERE session_id = ?`,
          )
          .bind(
            // Domain event ids are deterministic inside a demo journey and may
            // legitimately repeat in another anonymous session or after reset.
            // The storage key therefore includes both the session and append
            // sequence while payload_json preserves the domain event unchanged.
            storageId,
            this.sessionId,
            event.at,
            event.type,
            JSON.stringify(event),
            this.sessionId,
          ),
      );
    }
    if (statements.length > 0) {
      await this.db.batch(statements);
      this.nextSeq += statements.length;
    }
  }

  private async loadOrSeed(): Promise<DemoSnapshot> {
    try {
      const maxSeqRow = await this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE session_id = ?`,
        )
        .bind(this.sessionId)
        .first<{ max_seq: number }>();
      this.nextSeq = (maxSeqRow?.max_seq ?? 0) + 1;

      const events = await this.loadEvents();
      if (events.length > 0) {
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
        await this.persistSnapshot(snapshot);
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
      await this.appendPersisted(seedEvents);
      await this.persistSnapshot(fresh);
      this.rebuildExecutionIndex(fresh.events);
      this.degraded = null;
      return fresh;
    } catch (error) {
      return this.degradedSnapshot(error);
    }
  }

  getDegraded() {
    return this.degraded;
  }

  async getSnapshot(): Promise<DemoSnapshot> {
    await this.ensureReady();
    if (!this.mutating && !this.degraded) {
      this.snapshot = await this.loadOrSeed();
    }
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    return structuredClone(this.snapshot);
  }

  async getSnapshotUnsafe(): Promise<DemoSnapshot> {
    await this.ensureReady();
    return structuredClone(this.snapshot);
  }

  async getEpisode(id: string): Promise<ClaimEpisode | undefined> {
    await this.ensureReady();
    if (!this.mutating && !this.degraded) {
      this.snapshot = await this.loadOrSeed();
    }
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    return this.snapshot.episodes.find((e) => e.id === id);
  }

  async beginMutation(): Promise<void> {
    await this.ensureReady();
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.mutating = true;
  }

  async abortMutation(): Promise<void> {
    await this.ensureReady();
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.mutating = false;
    if (!this.degraded) {
      this.snapshot = await this.loadOrSeed();
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

  async commit(): Promise<DemoSnapshot> {
    await this.ensureReady();
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
    await this.appendPersisted(toAppend);
    await this.persistSnapshot(this.snapshot);
    this.rebuildExecutionIndex(this.snapshot.events);
    this.mutating = false;
    return structuredClone(this.snapshot);
  }

  async getExecutionReceipt(
    idempotencyKey: string,
  ): Promise<string | undefined> {
    await this.ensureReady();
    const cached = this.executionIndex.get(idempotencyKey);
    if (cached) return cached;
    const row = await this.db
      .prepare(
        `SELECT receipt_id FROM action_reservations
         WHERE session_id = ? AND client_request_id = ?`,
      )
      .bind(this.sessionId, idempotencyKey)
      .first<{ receipt_id: string | null }>();
    return row?.receipt_id ?? undefined;
  }

  withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const runMutation = async () => {
      await this.ensureReady();
      if (!this.degraded) {
        this.snapshot = await this.loadOrSeed();
      }
      return fn();
    };
    const run = this.mutationLockTail.then(runMutation, runMutation);
    this.mutationLockTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async findApprovalConsumed(input: {
    episodeId: string;
    actionType: string;
  }): Promise<ApprovalConsumedEvent | undefined> {
    await this.ensureReady();
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

  async rememberExecution(idempotencyKey: string, receiptId: string): Promise<void> {
    this.executionIndex.set(idempotencyKey, receiptId);
    await this.db
      .prepare(
        `UPDATE action_reservations
         SET status = 'completed', receipt_id = ?
         WHERE session_id = ? AND client_request_id = ?`,
      )
      .bind(receiptId, this.sessionId, idempotencyKey)
      .run();
  }

  async reset(): Promise<DemoSnapshot> {
    await this.ensureReady();
    if (!this.degraded) {
      this.snapshot = await this.loadOrSeed();
    }
    this.mutating = false;
    const nextRevision = (this.snapshot.sessionRevision || 1) + 1;
    const boundary: DomainEvent = {
      type: "demo.session.reset",
      id: `event-reset-${this.sessionId}-${nextRevision}`,
      at: getDemoClock(),
      sessionRevision: nextRevision,
    };
    if (this.degraded) {
      await this.db
        .prepare(`DELETE FROM events WHERE session_id = ?`)
        .bind(this.sessionId)
        .run();
      this.nextSeq = 1;
      this.degraded = null;
    }
    // Reset is a new demo journey. Clear every session-scoped idempotency,
    // conversation, and BFF binding so deterministic fixture actions can run
    // again without inheriting a failed or completed reservation.
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM action_reservations WHERE session_id = ?`)
        .bind(this.sessionId),
      this.db
        .prepare(
          `DELETE FROM conversation_messages WHERE conversation_id IN
           (SELECT id FROM conversations WHERE session_id = ?)`,
        )
        .bind(this.sessionId),
      this.db
        .prepare(`DELETE FROM conversations WHERE session_id = ?`)
        .bind(this.sessionId),
      this.db
        .prepare(`DELETE FROM episode_thread_bindings WHERE session_id = ?`)
        .bind(this.sessionId),
    ]);
    const fresh = createInitialSnapshot({
      healthcareMode: this.healthcareMode,
      agentMode: this.agentMode,
    });
    fresh.sessionRevision = nextRevision;
    const projected: DomainEvent[] = fresh.episodes.map(
      (episode, index): DomainEvent => ({
        type: "episode.projected",
        id: `event-reset-episode-${this.sessionId}-${nextRevision}-${index + 1}`,
        at: getDemoClock(),
        episodeId: episode.id,
        schemaVersion: 1,
        episode: structuredClone(episode),
      }),
    );
    const seed = [boundary, ...projected];
    await this.appendPersisted(seed);
    fresh.events = seed;
    fresh.degraded = null;
    this.executionIndex.clear();
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.snapshot = fresh;
    await this.persistSnapshot(this.snapshot);
    this.rebuildExecutionIndex(this.snapshot.events);
    return structuredClone(this.snapshot);
  }

  async reserveAction(input: {
    clientRequestId: string;
    episodeId: string;
    actionType: string;
  }): Promise<{ reserved: boolean; existingReceiptId?: string }> {
    await this.ensureReady();
    const existing = await this.db
      .prepare(
        `SELECT receipt_id, status FROM action_reservations
         WHERE session_id = ? AND client_request_id = ?`,
      )
      .bind(this.sessionId, input.clientRequestId)
      .first<{ receipt_id: string | null; status: string }>();
    if (existing) {
      return {
        reserved: false,
        existingReceiptId: existing.receipt_id ?? undefined,
      };
    }
    try {
      await this.db
        .prepare(
          `INSERT INTO action_reservations
           (id, session_id, client_request_id, episode_id, action_type, status, receipt_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'reserved', NULL, ?)`,
        )
        .bind(
          `reservation-${this.sessionId}-${input.clientRequestId}`,
          this.sessionId,
          input.clientRequestId,
          input.episodeId,
          input.actionType,
          getDemoClock(),
        )
        .run();
      return { reserved: true };
    } catch {
      const raced = await this.db
        .prepare(
          `SELECT receipt_id FROM action_reservations
           WHERE session_id = ? AND client_request_id = ?`,
        )
        .bind(this.sessionId, input.clientRequestId)
        .first<{ receipt_id: string | null }>();
      return {
        reserved: false,
        existingReceiptId: raced?.receipt_id ?? undefined,
      };
    }
  }

  async saveConversation(
    episodeId: string,
    messages: ConversationMessage[],
  ): Promise<void> {
    await this.ensureReady();
    const conversationId = `${this.sessionId}:${episodeId}`;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO conversations (id, session_id, episode_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .bind(conversationId, this.sessionId, episodeId, getDemoClock()),
      this.db
        .prepare(`DELETE FROM conversation_messages WHERE conversation_id = ?`)
        .bind(conversationId),
    ];
    for (const message of messages) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO conversation_messages
             (id, conversation_id, role, content, intent, citations_json, created_at, client_request_id, proposal_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            message.id,
            conversationId,
            message.role,
            message.content,
            message.intent,
            JSON.stringify(message.citations),
            message.createdAt,
            message.clientRequestId ?? null,
            message.proposalId ?? null,
          ),
      );
    }
    await this.db.batch(statements);
  }

  async loadConversation(episodeId: string): Promise<ConversationMessage[]> {
    await this.ensureReady();
    const conversationId = `${this.sessionId}:${episodeId}`;
    const result = await this.db
      .prepare(
        `SELECT id, role, content, intent, citations_json, created_at, client_request_id, proposal_id
         FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
      )
      .bind(conversationId)
      .all<{
        id: string;
        role: "user" | "assistant";
        content: string;
        intent: ConversationMessage["intent"];
        citations_json: string;
        created_at: string;
        client_request_id: string | null;
        proposal_id: string | null;
      }>();
    return (result.results ?? []).map((row) => ({
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
    await this.ensureReady();
    await this.db
      .prepare(
        `INSERT INTO episode_thread_bindings (id, session_id, episode_id, thread_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id`,
      )
      .bind(`${this.sessionId}:${episodeId}`, this.sessionId, episodeId, threadId)
      .run();
  }

  async getThreadBinding(episodeId: string): Promise<string | null> {
    await this.ensureReady();
    const row = await this.db
      .prepare(
        `SELECT thread_id FROM episode_thread_bindings
         WHERE session_id = ? AND episode_id = ?`,
      )
      .bind(this.sessionId, episodeId)
      .first<{ thread_id: string }>();
    return row?.thread_id ?? null;
  }
}

/** Returns the Worker-scoped D1 repository for a session, creating on first use. */
export function getD1SessionRepository(
  sessionId: string,
  db: D1DatabaseLike,
  options?: StoreOptions,
): D1SessionRepository {
  const registry = d1Registry();
  let repo = registry.get(sessionId);
  if (!repo) {
    repo = new D1SessionRepository(sessionId, db, options);
    registry.set(sessionId, repo);
  }
  return repo;
}

export function resetD1SessionRegistry(): void {
  d1Registry().clear();
}

/** Helper for tests that need to assert a round-tripped snapshot parses. */
export function assertSnapshotParsable(snapshot: DemoSnapshot): DemoSnapshot {
  return parseDemoSnapshot(snapshot);
}
