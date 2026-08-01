import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createSeedEpisodes } from "@/domain/fixtures";
import { getDemoClock } from "@/domain/clock";
import type {
  AgentMode,
  ClaimEpisode,
  DemoSnapshot,
  DomainEvent,
  HealthcareMode,
} from "@/domain/types";
import { evaluateDiscrepancies } from "@/domain/discrepancy";
import { buildReprocessingProposal, buildSubmitProposal } from "@/domain/proposals";

export interface StoreOptions {
  dataDir?: string;
  healthcareMode?: HealthcareMode;
  agentMode?: AgentMode;
}

export class StoreDegradedError extends Error {
  readonly status = 503;
  readonly recovery: string;

  constructor(reason: string, recovery: string) {
    super(reason);
    this.name = "StoreDegradedError";
    this.recovery = recovery;
  }
}

function defaultDataDir(): string {
  return process.env.DEMO_DATA_DIR
    ? path.resolve(process.cwd(), process.env.DEMO_DATA_DIR)
    : path.resolve(process.cwd(), "var", "demo");
}

function eventsPath(dataDir: string): string {
  return path.join(dataDir, "events.ndjson");
}

function snapshotPath(dataDir: string): string {
  return path.join(dataDir, "snapshot.json");
}

function ensureDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
}

/**
 * Recompute discrepancies and seed proposals only when still approval_required.
 * Denied / submitted / investigating episodes must not regain a proposal.
 */
function rehydrateEpisode(episode: ClaimEpisode): ClaimEpisode {
  const next: ClaimEpisode = {
    ...episode,
    fhirResources: episode.fhirResources ?? [],
  };
  next.discrepancies = evaluateDiscrepancies(next);

  if (next.proposal) {
    return next;
  }

  if (next.resolutionState !== "approval_required") {
    return next;
  }

  if (next.fixtureKey === "encounter-a" && !next.submissionReceiptId) {
    next.proposal = buildSubmitProposal(next);
  } else if (
    next.fixtureKey === "claim-c" &&
    !next.reprocessingReceiptId &&
    next.adjudicationState === "denied"
  ) {
    next.proposal = buildReprocessingProposal(next);
  }
  return next;
}

export function createInitialSnapshot(options: StoreOptions = {}): DemoSnapshot {
  const episodes = createSeedEpisodes().map(rehydrateEpisode);
  return {
    demoClock: getDemoClock(),
    sessionRevision: 1,
    healthcareMode: options.healthcareMode ?? "local",
    agentMode: options.agentMode ?? "synthetic",
    episodes,
    events: [
      {
        type: "demo.session.reset",
        id: "event-seed-1",
        at: getDemoClock(),
        sessionRevision: 1,
      },
    ],
    degraded: null,
  };
}

function parseNdjson(text: string): DomainEvent[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as DomainEvent;
    } catch {
      throw new StoreDegradedError(
        `Corrupt NDJSON event at line ${index + 1}`,
        "Use Reset demo to quarantine the corrupt ledger and restore the synthetic seed projection.",
      );
    }
  });
}

/** Reduce append-only domain events into a DemoSnapshot from the latest reset. */
export function replayEvents(
  events: DomainEvent[],
  options: StoreOptions,
): DemoSnapshot {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "demo.session.reset") {
      start = i;
      break;
    }
  }

  let snapshot: DemoSnapshot | null = null;
  for (let i = start; i < events.length; i += 1) {
    snapshot = applyEvent(
      snapshot,
      events[i]!,
      options.healthcareMode ?? "local",
      options.agentMode ?? "synthetic",
    );
  }
  if (!snapshot) {
    return createInitialSnapshot(options);
  }
  snapshot.healthcareMode = options.healthcareMode ?? snapshot.healthcareMode;
  snapshot.agentMode = options.agentMode ?? snapshot.agentMode;
  snapshot.episodes = snapshot.episodes.map(rehydrateEpisode);
  snapshot.degraded = null;
  return snapshot;
}

export function applyEvent(
  current: DemoSnapshot | null,
  event: DomainEvent,
  healthcareMode: HealthcareMode,
  agentMode: AgentMode,
): DemoSnapshot {
  if (event.type === "demo.session.reset") {
    const fresh = createInitialSnapshot({ healthcareMode, agentMode });
    fresh.sessionRevision = event.sessionRevision;
    fresh.events = [event];
    return fresh;
  }

  if (!current) {
    current = createInitialSnapshot({ healthcareMode, agentMode });
    current.events = [];
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

  return {
    ...current,
    events: [...current.events, event],
  };
}

export class LocalEventStore {
  readonly dataDir: string;
  private healthcareMode: HealthcareMode;
  private agentMode: AgentMode;
  private snapshot: DemoSnapshot;
  private executionIndex = new Map<string, string>();
  private pendingEvents: DomainEvent[] = [];
  private dirtyEpisodeIds = new Set<string>();
  private degraded: { reason: string; recovery: string } | null = null;
  private mutating = false;
  private ledgerUnreadable = false;

  constructor(options: StoreOptions = {}) {
    this.dataDir = options.dataDir ?? defaultDataDir();
    this.healthcareMode =
      options.healthcareMode ??
      ((process.env.HEALTHCARE_MODE as HealthcareMode) || "local");
    this.agentMode =
      options.agentMode ?? ((process.env.AGENT_MODE as AgentMode) || "synthetic");
    ensureDir(this.dataDir);
    this.snapshot = this.loadOrSeed();
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

  private readEventLog(): DomainEvent[] {
    const file = eventsPath(this.dataDir);
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    if (!text.trim()) return [];
    return parseNdjson(text);
  }

  private loadOrSeed(): DemoSnapshot {
    const eventFile = eventsPath(this.dataDir);
    const snapFile = snapshotPath(this.dataDir);

    try {
      if (existsSync(eventFile)) {
        const events = this.readEventLog();
        this.ledgerUnreadable = false;
        if (events.length > 0) {
          const replayed = replayEvents(events, {
            healthcareMode: this.healthcareMode,
            agentMode: this.agentMode,
          });
          this.rebuildExecutionIndex(replayed.events);
          this.degraded = null;
          // Refresh atomic cache; NDJSON is source of truth.
          try {
            this.writeSnapshot(replayed);
          } catch {
            // Cache write failure is non-fatal when replay succeeded.
          }
          return replayed;
        }
      }

      if (existsSync(snapFile) && !existsSync(eventFile)) {
        // Orphan snapshot without ledger: treat as seedable but prefer fail-closed? Seed new ledger.
      }

      const fresh = createInitialSnapshot({
        healthcareMode: this.healthcareMode,
        agentMode: this.agentMode,
      });
      // Seed ledger with reset + projected episodes so replay reconstructs seed.
      const seedEvents: DomainEvent[] = [
        fresh.events[0]!,
        ...fresh.episodes.map(
          (episode, index): DomainEvent => ({
            type: "episode.projected",
            id: `event-seed-episode-${index + 1}`,
            at: getDemoClock(),
            episodeId: episode.id,
            schemaVersion: 1,
            episode: structuredClone(episode),
          }),
        ),
      ];
      fresh.events = seedEvents;
      this.writeSnapshot(fresh);
      if (!existsSync(eventFile) || readFileSync(eventFile, "utf8").trim() === "") {
        this.appendEventsToLog(seedEvents);
      }
      this.rebuildExecutionIndex(fresh.events);
      this.degraded = null;
      this.ledgerUnreadable = false;
      return fresh;
    } catch (error) {
      const reason =
        error instanceof StoreDegradedError
          ? error.message
          : error instanceof Error
            ? `Corrupt local demo store: ${error.message}`
            : "Corrupt local demo store";
      const recovery =
        error instanceof StoreDegradedError
          ? error.recovery
          : "Use Reset demo to quarantine the corrupt ledger and restore the synthetic seed projection.";
      this.degraded = { reason, recovery };
      this.ledgerUnreadable =
        error instanceof StoreDegradedError &&
        error.message.startsWith("Corrupt NDJSON");
      const degradedSnap = createInitialSnapshot({
        healthcareMode: this.healthcareMode,
        agentMode: this.agentMode,
      });
      degradedSnap.degraded = this.degraded;
      return degradedSnap;
    }
  }

  private writeSnapshot(snapshot: DemoSnapshot): void {
    ensureDir(this.dataDir);
    const tmp = `${snapshotPath(this.dataDir)}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, snapshotPath(this.dataDir));
  }

  private appendEventsToLog(events: DomainEvent[]): void {
    if (events.length === 0) return;
    if (this.ledgerUnreadable) {
      throw new StoreDegradedError(
        "Cannot append to an unreadable corrupt event ledger",
        "Use Reset demo to quarantine the corrupt ledger first.",
      );
    }
    ensureDir(this.dataDir);
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(eventsPath(this.dataDir), lines);
  }

  private quarantineCorruptLedger(): string | null {
    const file = eventsPath(this.dataDir);
    if (!existsSync(file)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(
      this.dataDir,
      `events.ndjson.corrupt-${stamp}.quarantine`,
    );
    renameSync(file, dest);
    return dest;
  }

  getDegraded(): { reason: string; recovery: string } | null {
    return this.degraded;
  }

  getSnapshot(): DemoSnapshot {
    const before = this.getDegraded();
    if (before) {
      throw new StoreDegradedError(before.reason, before.recovery);
    }
    if (!this.mutating) {
      this.snapshot = this.loadOrSeed();
      const after = this.getDegraded();
      if (after) {
        throw new StoreDegradedError(after.reason, after.recovery);
      }
    }
    return structuredClone(this.snapshot);
  }

  getSnapshotUnsafe(): DemoSnapshot {
    if (!this.mutating) {
      this.snapshot = this.loadOrSeed();
    }
    return structuredClone(this.snapshot);
  }

  getEpisode(id: string): ClaimEpisode | undefined {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    if (!this.mutating) {
      this.snapshot = this.loadOrSeed();
    }
    return this.snapshot.episodes.find((e) => e.id === id);
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

  beginMutation(): void {
    const before = this.getDegraded();
    if (before) {
      throw new StoreDegradedError(before.reason, before.recovery);
    }
    this.snapshot = this.loadOrSeed();
    const after = this.getDegraded();
    if (after) {
      throw new StoreDegradedError(after.reason, after.recovery);
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
    const toAppend = [...this.pendingEvents];
    this.pendingEvents = [];
    this.appendEventsToLog(toAppend);
    this.writeSnapshot(this.snapshot);
    this.rebuildExecutionIndex(this.snapshot.events);
    this.mutating = false;
    return structuredClone(this.snapshot);
  }

  getExecutionReceipt(idempotencyKey: string): string | undefined {
    if (this.degraded) {
      throw new StoreDegradedError(this.degraded.reason, this.degraded.recovery);
    }
    if (!this.mutating) {
      this.snapshot = this.loadOrSeed();
    }
    return this.executionIndex.get(idempotencyKey);
  }

  findApprovalConsumed(input: {
    episodeId: string;
    actionType: string;
  }): Extract<DomainEvent, { type: "approval.consumed" }> | undefined {
    const events = this.mutating
      ? this.snapshot.events
      : this.getSnapshot().events;
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
  }

  readAppendOnlyHistory(): DomainEvent[] {
    return this.readEventLog();
  }

  reset(): DemoSnapshot {
    this.mutating = false;
    const wasDegraded = this.degraded != null;
    const current =
      wasDegraded ? this.getSnapshotUnsafe() : this.loadOrSeed();
    const nextRevision = (current.sessionRevision || 1) + 1;
    const boundary: DomainEvent = {
      type: "demo.session.reset",
      id: `event-reset-${nextRevision}`,
      at: getDemoClock(),
      sessionRevision: nextRevision,
    };

    if (wasDegraded && this.ledgerUnreadable) {
      this.quarantineCorruptLedger();
      this.ledgerUnreadable = false;
      const fresh = createInitialSnapshot({
        healthcareMode: this.healthcareMode,
        agentMode: this.agentMode,
      });
      fresh.sessionRevision = nextRevision;
      const seedEvents: DomainEvent[] = [
        boundary,
        ...fresh.episodes.map(
          (episode, index): DomainEvent => ({
            type: "episode.projected",
            id: `event-reset-episode-${nextRevision}-${index + 1}`,
            at: getDemoClock(),
            episodeId: episode.id,
            schemaVersion: 1,
            episode: structuredClone(episode),
          }),
        ),
      ];
      fresh.events = seedEvents;
      fresh.degraded = null;
      writeFileSync(
        eventsPath(this.dataDir),
        seedEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      this.degraded = null;
      this.executionIndex.clear();
      this.pendingEvents = [];
      this.dirtyEpisodeIds.clear();
      this.snapshot = fresh;
      this.writeSnapshot(this.snapshot);
      this.rebuildExecutionIndex(this.snapshot.events);
      return structuredClone(this.snapshot);
    }

    // Healthy reset: append boundary (preserve history), then project seed.
    this.appendEventsToLog([boundary]);
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
    this.appendEventsToLog(projected);
    fresh.events = [boundary, ...projected];
    fresh.degraded = null;
    this.degraded = null;
    this.executionIndex.clear();
    this.pendingEvents = [];
    this.dirtyEpisodeIds.clear();
    this.snapshot = fresh;
    this.writeSnapshot(this.snapshot);
    this.rebuildExecutionIndex(this.snapshot.events);
    return structuredClone(this.snapshot);
  }
}

let singleton: LocalEventStore | null = null;

export function getStore(options?: StoreOptions): LocalEventStore {
  if (options?.dataDir) {
    return new LocalEventStore(options);
  }
  if (!singleton) {
    singleton = new LocalEventStore(options);
  }
  return singleton;
}

export function resetStoreSingleton(): void {
  singleton = null;
}
