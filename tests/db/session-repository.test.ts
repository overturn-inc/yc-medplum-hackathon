import { describe, expect, it } from "vitest";
import { proposalApprovalFields } from "@/domain/approval";
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
  type D1DatabaseLike,
  type D1PreparedStatement,
} from "@/server/d1-repository";

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
    // `createSessionRepository` returns the same registered MemorySessionRepository
    // instance for a given sessionId, so these two ActionServices share one
    // repository -- exactly the cross-instance race `withMutationLock` must
    // serialize (the old per-ActionService `enqueueMutation` mutex could not).
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

    function wrap(): D1DatabaseLike {
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
            async run() {
              const info = sqlite.prepare(query).run(...this.binds);
              return { success: true, meta: { changes: info.changes } };
            },
          };
          return stmt;
        },
        async batch(statements: D1PreparedStatement[]) {
          const results = [];
          for (const statement of statements) {
            results.push(await statement.run());
          }
          return results;
        },
      };
    }

    const db = wrap();
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

    await repoA.rememberExecution("idem-key-shared", "receipt-winner");
    const again = await repoB.reserveAction!({
      clientRequestId: "idem-key-shared",
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
    });
    expect(again.reserved).toBe(false);
    expect(again.existingReceiptId).toBe("receipt-winner");

    // Same D1 repository instance + two ActionServices (cross-service, shared lock).
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

    // Deterministic event ids must not collide across anonymous sessions.
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

    // Reset starts a new journey in the same session: reservations and
    // deterministic action events from the previous journey cannot block it.
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
