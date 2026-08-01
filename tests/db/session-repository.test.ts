import { describe, expect, it } from "vitest";
import { proposalApprovalFields } from "@/domain/approval";
import { createSyntheticAgentAdapter } from "@/adapters/agent/synthetic";
import { ActionService } from "@/server/actions";
import {
  createSqliteSessionRepository,
  openSqliteDatabase,
  SqliteSessionRepository,
} from "@/server/sqlite-session-repository";
import { createSessionRepository } from "@/server/repository";
import { parseDomainEvent } from "@/domain/schemas";
import {
  D1SessionRepository,
  getD1SessionRepository,
  type D1DatabaseLike,
  type D1PreparedStatement,
  type D1SessionLike,
  type D1WriteResult,
} from "@/server/d1-repository";
import {
  StoreConflictError,
  StoreDegradedError,
  StorePersistenceError,
} from "@/server/store";
import type Database from "better-sqlite3";

const ENCOUNTER_A = "episode-encounter-a";
const RECEIPT_A = "receipt-submit-episode-encounter-a";

/**
 * SQLite-backed D1 test double. `batch` is transactional like real D1:
 * any thrown statement rolls the whole batch back.
 */
function createSqliteD1Database(
  sqlite: Database.Database,
  hooks?: {
    beforeRun?: (query: string) => D1WriteResult | "throw" | void;
    afterBatch?: (results: D1WriteResult[]) => D1WriteResult[];
  },
): D1DatabaseLike {
  return {
    prepare(query: string): D1PreparedStatement {
      const stmt = {
        binds: [] as unknown[],
        bind(...values: unknown[]) {
          this.binds = values;
          return this;
        },
        async first<T>() {
          const row = sqlite.prepare(query).get(...this.binds);
          return (row as T) ?? null;
        },
        async all<T>() {
          const rows = sqlite.prepare(query).all(...this.binds);
          return { results: rows as T[] };
        },
        async run(): Promise<D1WriteResult> {
          const intercepted = hooks?.beforeRun?.(query);
          if (intercepted === "throw") {
            throw new Error("injected D1 run failure");
          }
          if (intercepted) return intercepted;
          try {
            const info = sqlite.prepare(query).run(...this.binds);
            return { success: true, meta: { changes: info.changes } };
          } catch (error) {
            throw error;
          }
        },
      };
      return stmt;
    },
    async batch(statements: D1PreparedStatement[]): Promise<D1WriteResult[]> {
      // Drive statements sequentially inside a real SQLite transaction so a
      // mid-batch success=false / throw rolls back prior statements (D1 semantics).
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results: D1WriteResult[] = [];
        for (const statement of statements) {
          const result = await statement.run();
          if (result.success !== true) {
            sqlite.exec("ROLLBACK");
            const finalized = hooks?.afterBatch?.(results.concat(result));
            return finalized ?? results.concat(result);
          }
          results.push(result);
        }
        sqlite.exec("COMMIT");
        return hooks?.afterBatch?.(results) ?? results;
      } catch (error) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw error;
      }
    },
  };
}

describe("session and D1 repository isolation", () => {
  it("isolates two memory sessions; reset affects only one", async () => {
    const a = createSessionRepository("session-a");
    const b = createSessionRepository("session-b");
    const actionsA = new ActionService(a);
    await actionsA.createProposal("episode-encounter-a", "submit_claim");
    expect((await a.getEpisode("episode-encounter-a"))!.revision).toBeGreaterThan(1);
    expect((await b.getEpisode("episode-encounter-a"))!.revision).toBe(1);

    await a.reset();
    expect((await a.getEpisode("episode-encounter-a"))!.submissionReceiptId).toBeNull();
    expect((await b.getEpisode("episode-encounter-a"))!.revision).toBe(1);
  });

  it("persists append-only events and conversations in sqlite", async () => {
    const db = openSqliteDatabase(":memory:");
    const repo = new SqliteSessionRepository("sqlite-session-1", db);
    const actions = new ActionService(repo);
    const episode = await repo.getEpisode("episode-claim-c");
    expect(episode?.proposal).toBeTruthy();
    const scope = proposalApprovalFields(episode!.proposal!);
    await actions.decide({
      episodeId: "episode-claim-c",
      actionType: "request_reprocessing",
      decision: "allow_once",
      scope,
    });
    const after = await repo.getEpisode("episode-claim-c");
    expect(after?.reprocessingReceiptId).toBeTruthy();
    expect(after?.adjudicationState).toBe("denied");

    await repo.saveConversation!("episode-claim-c", [
      {
        id: "msg-1",
        episodeId: "episode-claim-c",
        role: "user",
        content: "Why denied?",
        intent: "reason",
        citations: [],
        createdAt: "2026-07-15T15:00:00.000Z",
        clientRequestId: "cr-1",
      },
    ]);
    const messages = await repo.loadConversation!("episode-claim-c");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Why denied?");

    const reservation = await repo.reserveAction!({
      clientRequestId: "cr-dup",
      episodeId: "episode-claim-c",
      actionType: "request_reprocessing",
    });
    expect(reservation.reserved).toBe(true);
    const again = await repo.reserveAction!({
      clientRequestId: "cr-dup",
      episodeId: "episode-claim-c",
      actionType: "request_reprocessing",
    });
    expect(again.reserved).toBe(false);
  });

  it("rejects corrupt event payloads on read (fail closed)", () => {
    const db = openSqliteDatabase(":memory:");
    const repo = new SqliteSessionRepository("sqlite-corrupt", db);
    // Seed healthy first.
    expect(repo.getSnapshot().episodes).toHaveLength(7);
    db.prepare(
      `INSERT INTO events (id, session_id, seq, at, type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "bad-event",
      "sqlite-corrupt",
      999,
      "2026-07-15T15:00:00.000Z",
      "not.a.real.event",
      JSON.stringify({ type: "not.a.real.event", id: "x" }),
    );
    const reloaded = new SqliteSessionRepository("sqlite-corrupt", db);
    expect(reloaded.getDegraded()).toBeTruthy();
  });

  it("concurrent duplicate approval has one effect", async () => {
    const repo = createSqliteSessionRepository("concurrent-session");
    const actions = new ActionService(repo);
    const episode = await repo.getEpisode("episode-encounter-a");
    const scope = proposalApprovalFields(episode!.proposal!);
    const [first, second] = await Promise.all([
      actions.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope,
      }),
      actions.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope,
      }),
    ]);
    const receipts = [first.receiptId, second.receiptId].filter(Boolean);
    expect(new Set(receipts).size).toBe(1);
    const submitted = (await repo.getSnapshot()).events.filter(
      (e) => e.type === "claim.submitted",
    );
    expect(submitted).toHaveLength(1);
  });

  it("two ActionService instances sharing one MemorySessionRepository race allow_once to exactly one effect", async () => {
    const sessionId = `mutation-lock-race-${Math.random().toString(36).slice(2)}`;
    const repoForA = createSessionRepository(sessionId);
    const repoForB = createSessionRepository(sessionId);
    expect(repoForA).toBe(repoForB);

    const actionsA = new ActionService(repoForA);
    const actionsB = new ActionService(repoForB);

    const episode = await repoForA.getEpisode("episode-encounter-a");
    const scope = proposalApprovalFields(episode!.proposal!);

    const [first, second] = await Promise.all([
      actionsA.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope,
      }),
      actionsB.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope,
      }),
    ]);

    const receipts = [first.receiptId, second.receiptId].filter(Boolean);
    expect(new Set(receipts).size).toBe(1);
    const idempotentFlags = [first, second].map((r) =>
      "idempotent" in r ? r.idempotent : false,
    );
    expect(idempotentFlags.filter(Boolean)).toHaveLength(1);

    const snapshot = await repoForA.getSnapshot();
    const consumed = snapshot.events.filter((e) => e.type === "approval.consumed");
    const submitted = snapshot.events.filter((e) => e.type === "claim.submitted");
    expect(consumed).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it("parseDomainEvent rejects unknown and extra fields", () => {
    expect(() =>
      parseDomainEvent({
        type: "demo.session.reset",
        id: "e1",
        at: "2026-07-15T15:00:00.000Z",
        sessionRevision: 1,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      parseDomainEvent({
        type: "totally.unknown",
        id: "e1",
        at: "2026-07-15T15:00:00.000Z",
      }),
    ).toThrow();
  });

  it("D1 unique reservation admits one winner across two repository instances", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const db = createSqliteD1Database(sqlite);
    const sessionId = `d1-reserve-${Math.random().toString(36).slice(2)}`;
    const repoA = new D1SessionRepository(sessionId, db);
    await repoA.getSnapshot();
    const repoB = new D1SessionRepository(sessionId, db);
    await repoB.getSnapshot();

    const [first, second] = await Promise.all([
      repoA.reserveAction!({
        clientRequestId: "idem-key-shared",
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
      }),
      repoB.reserveAction!({
        clientRequestId: "idem-key-shared",
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
      }),
    ]);

    expect([first, second].filter((r) => r.reserved)).toHaveLength(1);
    expect([first, second].some((r) => !r.reserved)).toBe(true);

    await repoA.beginMutation();
    await repoA.rememberExecution("idem-key-shared", "receipt-winner");
    await repoA.commit();
    const again = await repoB.reserveAction!({
      clientRequestId: "idem-key-shared",
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
    });
    expect(again.reserved).toBe(false);
    expect(again.existingReceiptId).toBe("receipt-winner");

    const sessionId2 = `d1-decide-${Math.random().toString(36).slice(2)}`;
    const shared = new D1SessionRepository(sessionId2, db);
    await shared.getSnapshot();
    const actionsA = new ActionService(shared);
    const actionsB = new ActionService(shared);
    const episode = await shared.getEpisode("episode-encounter-a");
    const scope = proposalApprovalFields(episode!.proposal!);
    const [decideA, decideB] = await Promise.all([
      actionsA.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope,
      }),
      actionsB.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope,
      }),
    ]);
    const receipts = [decideA.receiptId, decideB.receiptId].filter(Boolean);
    expect(new Set(receipts).size).toBe(1);
    const snapshot = await shared.getSnapshot();
    expect(snapshot.events.filter((e) => e.type === "approval.consumed")).toHaveLength(1);
    expect(snapshot.events.filter((e) => e.type === "claim.submitted")).toHaveLength(1);

    const other = new D1SessionRepository(
      `d1-other-${Math.random().toString(36).slice(2)}`,
      db,
    );
    const otherActions = new ActionService(other);
    const otherEpisode = await other.getEpisode("episode-encounter-a");
    const otherResult = await otherActions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(otherEpisode!.proposal!),
    });
    expect(otherResult.receiptId).toBeTruthy();

    await shared.reset();
    const resetEpisode = await shared.getEpisode("episode-encounter-a");
    const afterReset = await actionsA.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(resetEpisode!.proposal!),
    });
    expect(afterReset.receiptId).toBeTruthy();
  });
});

describe("D1 transactional durability (repair-v3)", () => {
  it("rejects batch success=false without throw and leaves no partial commit", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const sessionId = `d1-false-${Math.random().toString(36).slice(2)}`;
    await new D1SessionRepository(sessionId, createSqliteD1Database(sqlite)).getSnapshot();

    let eventInserts = 0;
    let armed = false;
    const db = createSqliteD1Database(sqlite, {
      beforeRun(query) {
        if (!armed) return;
        if (query.includes("INSERT INTO events")) {
          eventInserts += 1;
          if (eventInserts === 1) {
            return { success: false, meta: { changes: 0 } };
          }
        }
      },
    });
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();
    const beforeCount = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM events WHERE session_id = ?`).get(sessionId) as {
        c: number;
      }
    ).c;

    armed = true;
    await repo.beginMutation();
    const episode = (await repo.getEpisode(ENCOUNTER_A))!;
    repo.replaceEpisode({
      ...episode,
      revision: episode.revision + 1,
      issue: "should-not-persist",
    });
    await expect(repo.commit()).rejects.toBeInstanceOf(StorePersistenceError);

    const afterCount = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM events WHERE session_id = ?`).get(sessionId) as {
        c: number;
      }
    ).c;
    expect(afterCount).toBe(beforeCount);
    const reloaded = await new D1SessionRepository(sessionId, createSqliteD1Database(sqlite)).getEpisode(
      ENCOUNTER_A,
    );
    expect(reloaded?.issue).not.toBe("should-not-persist");
  });

  it("rejects missing batch results and does not return success", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const sessionId = `d1-missing-${Math.random().toString(36).slice(2)}`;
    await new D1SessionRepository(sessionId, createSqliteD1Database(sqlite)).getSnapshot();

    let armed = false;
    const db = createSqliteD1Database(sqlite, {
      afterBatch(results) {
        if (!armed) return results;
        return results.slice(0, Math.max(0, results.length - 1));
      },
    });
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();
    armed = true;
    await repo.beginMutation();
    const episode = (await repo.getEpisode(ENCOUNTER_A))!;
    repo.replaceEpisode({ ...episode, revision: episode.revision + 1 });
    await expect(repo.commit()).rejects.toBeInstanceOf(StorePersistenceError);
  });

  it("rolls back when the snapshot statement fails mid-batch", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const sessionId = `d1-snap-fail-${Math.random().toString(36).slice(2)}`;
    await new D1SessionRepository(sessionId, createSqliteD1Database(sqlite)).getSnapshot();

    let armed = false;
    const db = createSqliteD1Database(sqlite, {
      beforeRun(query) {
        if (!armed) return;
        if (query.includes("INSERT INTO sessions")) {
          return { success: false, meta: { changes: 0 } };
        }
      },
    });
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();
    const before = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM events WHERE session_id = ?`).get(sessionId) as {
        c: number;
      }
    ).c;

    armed = true;
    await repo.beginMutation();
    const episode = (await repo.getEpisode(ENCOUNTER_A))!;
    repo.replaceEpisode({
      ...episode,
      revision: 99,
      submissionReceiptId: "should-not-exist",
    });
    await expect(repo.commit()).rejects.toBeInstanceOf(StorePersistenceError);

    const after = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM events WHERE session_id = ?`).get(sessionId) as {
        c: number;
      }
    ).c;
    expect(after).toBe(before);
    const fresh = await new D1SessionRepository(
      sessionId,
      createSqliteD1Database(sqlite),
    ).getEpisode(ENCOUNTER_A);
    expect(fresh?.revision).not.toBe(99);
    expect(fresh?.submissionReceiptId).toBeNull();
  });

  it("failed durable reservation prevents connector execution", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const sessionId = `d1-reserve-fail-${Math.random().toString(36).slice(2)}`;
    await new D1SessionRepository(sessionId, createSqliteD1Database(sqlite)).getSnapshot();

    let armed = false;
    const db = createSqliteD1Database(sqlite, {
      beforeRun(query) {
        if (!armed) return;
        if (query.includes("INSERT INTO action_reservations")) {
          return { success: false, meta: { changes: 0 } };
        }
      },
    });
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();

    let connectorCalls = 0;
    const agent = createSyntheticAgentAdapter();
    const original = agent.executeApprovedAction.bind(agent);
    agent.executeApprovedAction = async (input) => {
      connectorCalls += 1;
      return original(input);
    };

    armed = true;
    const actions = new ActionService(repo, agent);
    const episode = await repo.getEpisode(ENCOUNTER_A);
    const result = await actions.decide({
      episodeId: ENCOUNTER_A,
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(episode!.proposal!),
    });

    expect(connectorCalls).toBe(0);
    expect(result.receiptId).toBeNull();
    expect("pendingVerification" in result && result.pendingVerification).toBe(true);
    const after = await repo.getEpisode(ENCOUNTER_A);
    expect(after?.submissionReceiptId).toBeNull();
    expect(after?.resolutionState).toBe("approval_required");
  });

  it("cross-instance stale writer conflicts and cannot roll back a newer revision", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const db = createSqliteD1Database(sqlite);
    const sessionId = `d1-stale-${Math.random().toString(36).slice(2)}`;

    const repoA = new D1SessionRepository(sessionId, db);
    const repoB = new D1SessionRepository(sessionId, db);
    await repoA.getSnapshot();
    await repoB.getSnapshot();

    const actionsA = new ActionService(repoA);
    const episodeA = await repoA.getEpisode(ENCOUNTER_A);
    const decided = await actionsA.decide({
      episodeId: ENCOUNTER_A,
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(episodeA!.proposal!),
    });
    expect(decided.receiptId).toBe(RECEIPT_A);
    expect((await repoA.getEpisode(ENCOUNTER_A))!.revision).toBe(2);
    expect((await repoA.getEpisode(ENCOUNTER_A))!.resolutionState).toBe("monitoring");

    // Stale isolate B still holds the pre-action nextSeq and snapshot.
    await repoB.beginMutation();
    const stale = (await repoB.getEpisode(ENCOUNTER_A))!;
    expect(stale.revision).toBe(1);
    expect(stale.submissionReceiptId).toBeNull();
    repoB.replaceEpisode({
      ...stale,
      issue: "stale-overwrite-attempt",
    });
    await expect(repoB.commit()).rejects.toBeInstanceOf(StoreConflictError);

    const durable = await new D1SessionRepository(
      sessionId,
      createSqliteD1Database(sqlite),
    ).getEpisode(ENCOUNTER_A);
    expect(durable?.revision).toBe(2);
    expect(durable?.resolutionState).toBe("monitoring");
    expect(durable?.submissionReceiptId).toBe(RECEIPT_A);
    expect(durable?.issue).not.toBe("stale-overwrite-attempt");
  });

  it("fresh repository immediately replays successful Encounter A approval", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const db = createSqliteD1Database(sqlite);
    const sessionId = `d1-fresh-${Math.random().toString(36).slice(2)}`;
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();
    const actions = new ActionService(repo);
    const episode = await repo.getEpisode(ENCOUNTER_A);
    const result = await actions.decide({
      episodeId: ENCOUNTER_A,
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(episode!.proposal!),
    });
    expect(result.receiptId).toBe(RECEIPT_A);

    const fresh = new D1SessionRepository(sessionId, createSqliteD1Database(sqlite));
    const replayed = await fresh.getEpisode(ENCOUNTER_A);
    expect(replayed?.revision).toBe(2);
    expect(replayed?.resolutionState).toBe("monitoring");
    expect(replayed?.submissionReceiptId).toBe(RECEIPT_A);
    expect(replayed?.transportState).toBe("clearinghouse_received");
  });

  it("Claim B uses one reservation key through durable completion", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const db = createSqliteD1Database(sqlite);
    const sessionId = `d1-claim-b-${Math.random().toString(36).slice(2)}`;
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();

    const result = await new ActionService(repo).refreshPayerStatus("episode-claim-b");
    expect(result.receiptId).toBeTruthy();
    expect(result.idempotent).toBe(false);

    const reservation = sqlite
      .prepare(
        `SELECT status, receipt_id FROM action_reservations
         WHERE session_id = ? AND action_type = 'refresh_payer_status'`,
      )
      .get(sessionId) as { status: string; receipt_id: string | null };
    expect(reservation.status).toBe("completed");
    expect(reservation.receipt_id).toBe(result.receiptId);

    const fresh = new D1SessionRepository(sessionId, createSqliteD1Database(sqlite));
    const claim = await fresh.getEpisode("episode-claim-b");
    expect(claim?.revision).toBe(2);
    expect(claim?.statusRefreshReceiptId).toBe(result.receiptId);
    expect(claim?.adjudicationState).toBe("accepted_for_processing");
  });

  it("normal reads never write sessions.snapshot_json", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    let sessionWrites = 0;
    const db = createSqliteD1Database(sqlite, {
      beforeRun(query) {
        if (query.includes("INSERT INTO sessions")) {
          sessionWrites += 1;
        }
      },
    });
    const sessionId = `d1-readonly-${Math.random().toString(36).slice(2)}`;
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();
    const writesAfterSeed = sessionWrites;
    expect(writesAfterSeed).toBeGreaterThan(0);

    await new D1SessionRepository(sessionId, db).getSnapshot();
    await repo.getEpisode(ENCOUNTER_A);
    await repo.getSnapshot();

    expect(sessionWrites).toBe(writesAfterSeed);
  });

  it("corrupt ledger fails closed and is not replaced by snapshot cache", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const db = createSqliteD1Database(sqlite);
    const sessionId = `d1-corrupt-${Math.random().toString(36).slice(2)}`;
    const repo = new D1SessionRepository(sessionId, db);
    await repo.getSnapshot();

    sqlite
      .prepare(
        `INSERT INTO events (id, session_id, seq, at, type, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "bad-d1-event",
        sessionId,
        9999,
        "2026-07-15T15:00:00.000Z",
        "not.a.real.event",
        JSON.stringify({ type: "not.a.real.event", id: "x" }),
      );

    // Poison the snapshot cache with a "healthy" looking blob — must not be trusted.
    sqlite
      .prepare(`UPDATE sessions SET snapshot_json = ? WHERE id = ?`)
      .run(JSON.stringify({ fake: true }), sessionId);

    const reloaded = new D1SessionRepository(sessionId, createSqliteD1Database(sqlite));
    await expect(reloaded.getSnapshot()).rejects.toBeInstanceOf(StoreDegradedError);
    expect(reloaded.getDegraded()).toBeTruthy();
  });

  it("requests withSession('first-primary') and routes all ledger I/O through that session", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const underlying = createSqliteD1Database(sqlite);
    const sessionConstraints: string[] = [];
    let sessionPrepare = 0;
    let sessionBatch = 0;
    let basePrepare = 0;
    let baseBatch = 0;

    const sessionHandle: D1SessionLike = {
      prepare(query: string) {
        sessionPrepare += 1;
        return underlying.prepare(query);
      },
      async batch(statements: D1PreparedStatement[]) {
        sessionBatch += 1;
        return underlying.batch(statements);
      },
      getBookmark() {
        return "test-bookmark";
      },
    };

    const binding: D1DatabaseLike = {
      prepare(query: string) {
        basePrepare += 1;
        return underlying.prepare(query);
      },
      async batch(statements: D1PreparedStatement[]) {
        baseBatch += 1;
        return underlying.batch(statements);
      },
      withSession(constraint) {
        sessionConstraints.push(String(constraint ?? "first-unconstrained"));
        return sessionHandle;
      },
    };

    const sessionId = `d1-session-api-${Math.random().toString(36).slice(2)}`;
    const repo = getD1SessionRepository(sessionId, binding);
    await repo.getSnapshot();
    expect(sessionConstraints).toEqual(["first-primary"]);
    expect(sessionPrepare).toBeGreaterThan(0);
    expect(sessionBatch).toBeGreaterThan(0);
    expect(basePrepare).toBe(0);
    expect(baseBatch).toBe(0);

    const prepareAfterSeed = sessionPrepare;
    const batchAfterSeed = sessionBatch;
    const actions = new ActionService(repo);
    const episode = await repo.getEpisode(ENCOUNTER_A);
    const decided = await actions.decide({
      episodeId: ENCOUNTER_A,
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(episode!.proposal!),
    });
    expect(decided.receiptId).toBe(RECEIPT_A);
    expect(sessionPrepare).toBeGreaterThan(prepareAfterSeed);
    expect(sessionBatch).toBeGreaterThan(batchAfterSeed);
    expect(basePrepare).toBe(0);
    expect(baseBatch).toBe(0);

    // A fresh repository in another isolate must open its own first-primary.
    const fresh = getD1SessionRepository(sessionId, binding);
    await fresh.getEpisode(ENCOUNTER_A);
    expect(sessionConstraints).toEqual(["first-primary", "first-primary"]);
    expect(basePrepare).toBe(0);
    expect(baseBatch).toBe(0);
  });

  it("commit failure refreshes first-primary rather than falling back to the base binding", async () => {
    const sqlite = openSqliteDatabase(":memory:");
    const underlying = createSqliteD1Database(sqlite);
    const sessionId = `d1-refresh-${Math.random().toString(36).slice(2)}`;
    await new D1SessionRepository(sessionId, underlying).getSnapshot();

    const sessionConstraints: string[] = [];
    let sessionHandles = 0;
    let armed = false;

    const makeSession = (): D1SessionLike => {
      sessionHandles += 1;
      return {
        prepare(query: string) {
          return underlying.prepare(query);
        },
        async batch(statements: D1PreparedStatement[]) {
          if (armed) {
            // Force a commit failure so the repository must refresh the session.
            return statements.map(() => ({ success: false, meta: { changes: 0 } }));
          }
          return underlying.batch(statements);
        },
      };
    };

    const binding: D1DatabaseLike = {
      prepare() {
        throw new Error("base binding prepare must not be used when withSession exists");
      },
      async batch() {
        throw new Error("base binding batch must not be used when withSession exists");
      },
      withSession(constraint) {
        sessionConstraints.push(String(constraint));
        return makeSession();
      },
    };

    const repo = new D1SessionRepository(sessionId, binding);
    await repo.getSnapshot();
    expect(sessionConstraints).toEqual(["first-primary"]);
    expect(sessionHandles).toBe(1);

    armed = true;
    await repo.beginMutation();
    const episode = (await repo.getEpisode(ENCOUNTER_A))!;
    repo.replaceEpisode({ ...episode, revision: episode.revision + 1 });
    await expect(repo.commit()).rejects.toBeInstanceOf(StorePersistenceError);

    // Failure path must open a new first-primary session for reload.
    expect(sessionConstraints).toEqual(["first-primary", "first-primary"]);
    expect(sessionHandles).toBe(2);
  });
});
