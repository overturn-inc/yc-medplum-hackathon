/**
 * Session-scoped durable repository abstraction.
 *
 * `SessionRepository` is the contract every request-path store must satisfy:
 * a `MemorySessionRepository` today (in-memory, optionally mirrored to disk
 * for local durability), and eventually a D1-backed implementation behind
 * the same interface (see `.openai/hosting.json`, `db/schema.ts`).
 *
 * Design note on sync vs. async: the mutation-lifecycle methods below are
 * typed to return `T | Promise<T>` rather than a bare `Promise<T>`. This is
 * deliberate so that:
 *   1. `MemorySessionRepository` (fully synchronous, in-memory) satisfies the
 *      interface without wrapping every read in a real microtask.
 *   2. `LocalEventStore` (`@/server/store`, sync/file-backed, used by existing
 *      unit tests that call its methods without `await`) also structurally
 *      satisfies this interface with zero changes to its public API.
 *   3. A future real network-backed implementation (D1 over HTTP) can return
 *      genuine `Promise<T>` without changing this type or any call site,
 *      because every call site is required to `await` these methods.
 * `appendEvent`, `replaceEpisode`, and `rememberExecution` stay plain
 * synchronous buffering operations (no I/O) in every implementation.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getDemoClock } from "@/domain/clock";
import { parseDomainEvent } from "@/domain/schemas";
import type {
  ClaimEpisode,
  ConversationMessage,
  DemoSnapshot,
  DomainEvent,
} from "@/domain/types";
import { getD1Binding } from "@/server/bindings";
import { getD1SessionRepository } from "@/server/d1-repository";
import {
  createInitialSnapshot,
  rehydrateEpisode,
  StoreDegradedError,
  type StoreOptions,
} from "@/server/store";

export type ApprovalConsumedEvent = Extract<
  DomainEvent,
  { type: "approval.consumed" }
>;

export interface SessionRepository {
  readonly sessionId: string;

  getSnapshot(): DemoSnapshot | Promise<DemoSnapshot>;
  getSnapshotUnsafe(): DemoSnapshot | Promise<DemoSnapshot>;
  getDegraded(): { reason: string; recovery: string } | null;
  getEpisode(
    id: string,
  ): ClaimEpisode | undefined | Promise<ClaimEpisode | undefined>;

  beginMutation(): void | Promise<void>;
  abortMutation(): void | Promise<void>;
  /** Buffered until `commit()`; never performs I/O by itself. */
  appendEvent(event: DomainEvent): void;
  /** Buffered until `commit()`; never performs I/O by itself. */
  replaceEpisode(episode: ClaimEpisode): void;
  commit(): DemoSnapshot | Promise<DemoSnapshot>;

  /**
   * Serializes an entire beginMutation -> ... -> commit/abortMutation
   * critical section on THIS repository instance, across every caller that
   * shares it (e.g. two `ActionService` instances constructed on top of the
   * same session repository). Callers must wrap the full mutation body
   * (including any awaited connector/agent calls) in `fn`, not just the
   * synchronous begin/commit calls, otherwise two interleaved mutations can
   * still clobber each other's buffered events between awaits.
   */
  withMutationLock<T>(fn: () => Promise<T>): Promise<T>;

  getExecutionReceipt(
    idempotencyKey: string,
  ): string | undefined | Promise<string | undefined>;
  findApprovalConsumed(input: {
    episodeId: string;
    actionType: string;
  }):
    | ApprovalConsumedEvent
    | undefined
    | Promise<ApprovalConsumedEvent | undefined>;
  rememberExecution(idempotencyKey: string, receiptId: string): void | Promise<void>;

  reset(): DemoSnapshot | Promise<DemoSnapshot>;

  reserveAction?(input: {
    clientRequestId: string;
    episodeId: string;
    actionType: string;
  }): Promise<{ reserved: boolean; existingReceiptId?: string }>;
  saveConversation?(
    episodeId: string,
    messages: ConversationMessage[],
  ): Promise<void>;
  loadConversation?(episodeId: string): Promise<ConversationMessage[]>;
  bindThread?(episodeId: string, threadId: string): Promise<void>;
  getThreadBinding?(episodeId: string): Promise<string | null>;
}

function defaultPersistDir(sessionId: string): string | null {
  if (!process.env.DEMO_DATA_DIR) return null;
  return path.join(
    path.resolve(process.cwd(), process.env.DEMO_DATA_DIR),
    "sessions",
    sessionId,
  );
}

function eventsPath(dir: string): string {
  return path.join(dir, "events.ndjson");
}

function snapshotPath(dir: string): string {
  return path.join(dir, "snapshot.json");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Validates events read back from the (optional) local mirror against the
 * zod schemas in `@/domain/schemas`, so a corrupt or hand-edited mirror
 * can't silently poison an in-memory session.
 */
function parsePlausibleDomainEvent(value: unknown): DomainEvent {
  return parseDomainEvent(value);
}

/**
 * In-memory, session-scoped repository. One instance per session id, held in
 * a process-global registry (`getSessionStore`) so state survives across
 * requests within the same server process -- but never leaks across
 * sessions, and is never a single shared ledger.
 *
 * When `DEMO_DATA_DIR` is set, each session best-effort mirrors its snapshot
 * and event log to `{DEMO_DATA_DIR}/sessions/{sessionId}/` for local
 * durability across process restarts. The in-memory copy is always the
 * source of truth for the life of the process; mirror I/O failures degrade
 * to "in-memory only" rather than failing the request.
 */
export class MemorySessionRepository implements SessionRepository {
  readonly sessionId: string;
  private readonly healthcareMode: DemoSnapshot["healthcareMode"];
  private readonly agentMode: DemoSnapshot["agentMode"];
  private readonly persistDir: string | null;

  private snapshot: DemoSnapshot;
  private executionIndex = new Map<string, string>();
  private pendingEvents: DomainEvent[] = [];
  private dirtyEpisodeIds = new Set<string>();
  private degraded: { reason: string; recovery: string } | null = null;
  private mutating = false;
  /** Session-scoped mutation lock tail; see `withMutationLock`. */
  private mutationLockTail: Promise<unknown> = Promise.resolve();

  private readonly conversations = new Map<string, ConversationMessage[]>();
  private readonly threadBindings = new Map<string, string>();
  private readonly reservations = new Map<
    string,
    { episodeId: string; actionType: string; receiptId?: string }
  >();

  constructor(sessionId: string, options: StoreOptions = {}) {
    this.sessionId = sessionId;
    this.healthcareMode =
      options.healthcareMode ??
      ((process.env.HEALTHCARE_MODE as DemoSnapshot["healthcareMode"]) ||
        "local");
    this.agentMode =
      options.agentMode ??
      ((process.env.AGENT_MODE as DemoSnapshot["agentMode"]) || "synthetic");
    this.persistDir = defaultPersistDir(sessionId);
    this.snapshot = this.loadOrSeed();
  }

  /**
   * Reads and validates the on-disk mirror. Returns `null` only when there
   * is legitimately no mirror yet (no persistDir, no file, or an empty
   * file) -- a genuinely fresh session. Any other problem (invalid JSON,
   * schema-invalid event, or a mirror with events but no
   * `demo.session.reset` boundary) throws `StoreDegradedError` so the
   * caller fails closed instead of silently reseeding over a mirror that
   * might still hold real history.
   */
  private loadMirroredEvents(): DomainEvent[] | null {
    if (!this.persistDir) return null;
    const file = eventsPath(this.persistDir);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    if (!text.trim()) return null;
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const events: DomainEvent[] = [];
    for (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new StoreDegradedError(
          "Corrupt local session mirror: invalid JSON",
          "Use Reset demo to quarantine the corrupt mirror and restore the synthetic seed for this session.",
        );
      }
      try {
        events.push(parsePlausibleDomainEvent(raw));
      } catch {
        throw new StoreDegradedError(
          "Corrupt local session mirror: event failed schema validation",
          "Use Reset demo to quarantine the corrupt mirror and restore the synthetic seed for this session.",
        );
      }
    }
    if (!events.some((e) => e.type === "demo.session.reset")) {
      throw new StoreDegradedError(
        "Corrupt local session mirror: missing demo.session.reset boundary",
        "Use Reset demo to quarantine the corrupt mirror and restore the synthetic seed for this session.",
      );
    }
    return events;
  }

  private reduceFromMirror(mirrored: DomainEvent[]): DemoSnapshot {
    let snapshot = createInitialSnapshot({
      healthcareMode: this.healthcareMode,
      agentMode: this.agentMode,
    });
    let start = 0;
    for (let i = mirrored.length - 1; i >= 0; i -= 1) {
      if (mirrored[i]?.type === "demo.session.reset") {
        start = i;
        break;
      }
    }
    snapshot.episodes = [];
    snapshot.events = [];
    for (let i = start; i < mirrored.length; i += 1) {
      snapshot = this.reduce(snapshot, mirrored[i]!);
    }
    snapshot.episodes = snapshot.episodes.map(rehydrateEpisode);
    return snapshot;
  }

  private degradedSnapshot(error: unknown): DemoSnapshot {
    const reason =
      error instanceof StoreDegradedError
        ? error.message
        : error instanceof Error
          ? `Corrupt local session mirror: ${error.message}`
          : "Corrupt local session mirror";
    const recovery =
      error instanceof StoreDegradedError
        ? error.recovery
        : "Use Reset demo to quarantine the corrupt mirror and restore the synthetic seed for this session.";
    this.degraded = { reason, recovery };
    const degradedSnap = createInitialSnapshot({
      healthcareMode: this.healthcareMode,
      agentMode: this.agentMode,
    });
    degradedSnap.degraded = this.degraded;
    return degradedSnap;
  }

  private loadOrSeed(): DemoSnapshot {
    let mirrored: DomainEvent[] | null;
    try {
      mirrored = this.loadMirroredEvents();
    } catch (error) {
      return this.degradedSnapshot(error);
    }

    if (mirrored && mirrored.length > 0) {
      const snapshot = this.reduceFromMirror(mirrored);
      this.rebuildExecutionIndex(snapshot.events);
      this.degraded = null;
      return snapshot;
    }

    const fresh = createInitialSnapshot({
      healthcareMode: this.healthcareMode,
      agentMode: this.agentMode,
    });
    this.rebuildExecutionIndex(fresh.events);
    this.degraded = null;
    this.persistBestEffort(fresh, fresh.events);
    return fresh;
  }

  private reduce(current: DemoSnapshot, event: DomainEvent): DemoSnapshot {
    if (event.type === "demo.session.reset") {
      const fresh = createInitialSnapshot({
        healthcareMode: this.healthcareMode,
        agentMode: this.agentMode,
      });
      fresh.sessionRevision = event.sessionRevision;
      fresh.events = [event];
      return fresh;
    }
    if (event.type === "episode.projected") {
      const episodes = current.episodes.map((episode) =>
        episode.id === event.episodeId
          ? rehydrateEpisode(structuredClone(event.episode))
          : episode,
      );
      const exists = episodes.some((e) => e.id === event.episodeId);
      return {
        ...current,
        episodes: exists
          ? episodes
          : [...episodes, rehydrateEpisode(structuredClone(event.episode))],
        events: [...current.events, event],
      };
    }
    return { ...current, events: [...current.events, event] };
  }

  private rebuildExecutionIndex(events: DomainEvent[]): void {
    this.executionIndex.clear();
    for (const event of events) {
      if (event.type === "approval.consumed" && event.receiptId) {
        this.executionIndex.set(event.idempotencyKey, event.receiptId);
      } else if (
        (event.type === "claim.submitted" ||
          event.type === "reprocessing.requested") &&
        "idempotencyKey" in event
      ) {
        this.executionIndex.set(event.idempotencyKey, event.receiptId);
      }
    }
  }

  /** Renames a corrupt mirror event log out of the way so a fresh one can be written. */
  private quarantineMirror(): void {
    if (!this.persistDir) return;
    const file = eventsPath(this.persistDir);
    try {
      if (!existsSync(file)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = path.join(
        this.persistDir,
        `events.ndjson.corrupt-${stamp}.quarantine`,
      );
      renameSync(file, dest);
    } catch {
      // Best-effort: if quarantine fails, persistBestEffort below will
      // still try to (over)write a fresh mirror.
    }
  }

  /** Mirrors current snapshot + newly appended events to disk. Never throws. */
  private persistBestEffort(
    snapshot: DemoSnapshot,
    newEvents: DomainEvent[],
  ): void {
    if (!this.persistDir) return;
    try {
      ensureDir(this.persistDir);
      if (newEvents.length > 0) {
        const lines = newEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
        appendFileSync(eventsPath(this.persistDir), lines);
      }
      const tmp = `${snapshotPath(this.persistDir)}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      renameSync(tmp, snapshotPath(this.persistDir));
    } catch {
      // Local durability is best-effort; the in-memory session remains authoritative.
    }
  }

  private refreshFromMirrorIfIdle(): void {
    if (this.mutating || !this.persistDir) return;
    let mirrored: DomainEvent[] | null;
    try {
      mirrored = this.loadMirroredEvents();
    } catch (error) {
      // Fail closed: if the mirror became corrupt since the last read (e.g.
      // another process/bundle wrote a bad line), degrade this session too
      // instead of silently continuing on stale in-memory state.
      this.degradedSnapshot(error);
      return;
    }
    if (!mirrored || mirrored.length === 0) return;
    // Another Next.js server bundle may have committed newer events to disk.
    if (mirrored.length <= this.snapshot.events.length) return;
    const snapshot = this.reduceFromMirror(mirrored);
    this.snapshot = snapshot;
    this.rebuildExecutionIndex(snapshot.events);
    this.degraded = null;
  }

  getSnapshot(): DemoSnapshot {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    this.refreshFromMirrorIfIdle();
    return structuredClone(this.snapshot);
  }

  getSnapshotUnsafe(): DemoSnapshot {
    this.refreshFromMirrorIfIdle();
    return structuredClone(this.snapshot);
  }

  getDegraded(): { reason: string; recovery: string } | null {
    return this.degraded;
  }

  getEpisode(id: string): ClaimEpisode | undefined {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    this.refreshFromMirrorIfIdle();
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
  }

  appendEvent(event: DomainEvent): void {
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
      this.pendingEvents.push(projected);
      this.snapshot.events.push(projected);
    }
    this.dirtyEpisodeIds.clear();
    const toPersist = [...this.pendingEvents];
    this.pendingEvents = [];
    this.rebuildExecutionIndex(this.snapshot.events);
    this.mutating = false;
    this.persistBestEffort(this.snapshot, toPersist);
    return structuredClone(this.snapshot);
  }

  getExecutionReceipt(idempotencyKey: string): string | undefined {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    return this.executionIndex.get(idempotencyKey);
  }

  findApprovalConsumed(input: {
    episodeId: string;
    actionType: string;
  }): ApprovalConsumedEvent | undefined {
    const events = this.snapshot.events;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
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
    const existing = this.reservations.get(
      `${this.sessionId}:${idempotencyKey}`,
    );
    if (existing) {
      existing.receiptId = receiptId;
    }
  }

  reset(): DemoSnapshot {
    const wasDegraded = this.degraded != null;
    this.mutating = false;
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.degraded = null;

    // A degraded session's mirror (if any) could not be trusted enough to
    // load -- quarantine it before writing a fresh boundary so the next
    // load never trips over the same corrupt lines again.
    if (wasDegraded) {
      this.quarantineMirror();
    }

    const nextRevision = (this.snapshot.sessionRevision || 1) + 1;
    const boundary: DomainEvent = {
      type: "demo.session.reset",
      id: `event-reset-${this.sessionId}-${nextRevision}`,
      at: getDemoClock(),
      sessionRevision: nextRevision,
    };
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
    fresh.events = [boundary, ...projected];
    this.snapshot = fresh;
    this.rebuildExecutionIndex(this.snapshot.events);
    this.persistBestEffort(this.snapshot, this.snapshot.events);
    return structuredClone(this.snapshot);
  }

  /**
   * Serializes every beginMutation -> commit/abortMutation critical section
   * on this repository instance, across every caller (including two
   * different `ActionService` instances sharing this same repository). The
   * lock covers the caller's entire async `fn`, not just the synchronous
   * begin/commit pair, so an awaited connector call mid-mutation can never
   * be interleaved with another caller's `beginMutation`.
   */
  withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationLockTail.then(fn, fn);
    this.mutationLockTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async reserveAction(input: {
    clientRequestId: string;
    episodeId: string;
    actionType: string;
  }): Promise<{ reserved: boolean; existingReceiptId?: string }> {
    const key = `${this.sessionId}:${input.clientRequestId}`;
    const existing = this.reservations.get(key);
    if (existing) {
      return { reserved: false, existingReceiptId: existing.receiptId };
    }
    this.reservations.set(key, {
      episodeId: input.episodeId,
      actionType: input.actionType,
    });
    return { reserved: true };
  }

  async saveConversation(
    episodeId: string,
    messages: ConversationMessage[],
  ): Promise<void> {
    this.conversations.set(episodeId, [...messages]);
  }

  async loadConversation(episodeId: string): Promise<ConversationMessage[]> {
    return [...(this.conversations.get(episodeId) ?? [])];
  }

  async bindThread(episodeId: string, threadId: string): Promise<void> {
    this.threadBindings.set(episodeId, threadId);
  }

  async getThreadBinding(episodeId: string): Promise<string | null> {
    return this.threadBindings.get(episodeId) ?? null;
  }
}

type GlobalSessionState = {
  __harborviewSessionRegistry?: Map<string, MemorySessionRepository>;
};

/**
 * Next.js may evaluate server modules in more than one bundle/isolate.
 * Keep the session map on `globalThis` so API routes and RSC pages share
 * the same MemorySessionRepository instances for a given cookie.
 */
const sessionRegistry: Map<string, MemorySessionRepository> = (() => {
  const g = globalThis as unknown as GlobalSessionState;
  if (!g.__harborviewSessionRegistry) {
    g.__harborviewSessionRegistry = new Map();
  }
  return g.__harborviewSessionRegistry;
})();

/**
 * Returns the process-wide singleton repository for a given session id,
 * creating it on first access. Safe for local multi-session isolation: each
 * cookie value gets its own entry, and `reset()` only clears that entry's
 * own state -- never the whole registry.
 */
export function getSessionStore(
  sessionId: string,
  options?: StoreOptions,
): MemorySessionRepository {
  let repo = sessionRegistry.get(sessionId);
  if (!repo) {
    repo = new MemorySessionRepository(sessionId, options);
    sessionRegistry.set(sessionId, repo);
  }
  return repo;
}

/** Factory for a session-scoped repository. Defaults to `MemorySessionRepository`. */
export function createSessionRepository(
  sessionId: string,
  options?: StoreOptions,
): SessionRepository {
  const d1 = getD1Binding();
  if (d1) {
    return getD1SessionRepository(sessionId, d1, options);
  }
  return getSessionStore(sessionId, options);
}

/** Test-only: drop every registered session so tests don't leak state across files. */
export function resetSessionRegistry(): void {
  sessionRegistry.clear();
}
