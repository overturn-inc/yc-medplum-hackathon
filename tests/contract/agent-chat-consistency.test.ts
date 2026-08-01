/**
 * Regression: post-action chat must render assistant content and citations
 * from the same refreshed durable episode inside the final mutation lock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBffAgentAdapter } from "@/adapters/agent/bff";
import { proposalApprovalFields } from "@/domain/approval";
import type { ClaimEpisode } from "@/domain/types";
import { ActionService } from "@/server/actions";
import { createAgentChatService } from "@/server/agent-chat";
import { LocalEventStore } from "@/server/store";

const ENCOUNTER_A = "episode-encounter-a";
const RECEIPT_ID = "receipt-submit-episode-encounter-a";

function tempStore(agentMode: "synthetic" | "bff" = "synthetic") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-chat-consistency-"));
  return new LocalEventStore({ dataDir, healthcareMode: "local", agentMode });
}

function scopeFor(store: LocalEventStore, episodeId: string) {
  const episode = store.getEpisode(episodeId)!;
  expect(episode.proposal).toBeTruthy();
  return proposalApprovalFields(episode.proposal!);
}

/** First getEpisode for the target id returns a stale clone; later reads hit durable state. */
function withLaggedFirstRead(
  store: LocalEventStore,
  episodeId: string,
  stale: ClaimEpisode,
): LocalEventStore {
  let reads = 0;
  const original = store.getEpisode.bind(store);
  store.getEpisode = (id: string) => {
    if (id === episodeId) {
      reads += 1;
      if (reads === 1) return structuredClone(stale);
    }
    return original(id);
  };
  return store;
}

function sseFrame(event: unknown, id: number): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function submitEncounterA(store: LocalEventStore) {
  const actions = new ActionService(store);
  const result = await actions.decide({
    episodeId: ENCOUNTER_A,
    actionType: "submit_claim",
    decision: "allow_once",
    scope: scopeFor(store, ENCOUNTER_A),
  });
  expect(result.receiptId).toBe(RECEIPT_ID);
  const submitted = store.getEpisode(ENCOUNTER_A)!;
  expect(submitted.submissionReceiptId).toBe(RECEIPT_ID);
  expect(submitted.resolutionState).toBe("monitoring");
  return submitted;
}

function expectSubmittedStatusAnswer(content: string, citations: Array<{ reference: string }>) {
  expect(content).toContain(RECEIPT_ID);
  expect(content).toContain("monitoring");
  expect(content).not.toContain("ready for claim submission");
  expect(
    citations.some(
      (c) =>
        c.reference.includes(RECEIPT_ID) ||
        c.reference.toLowerCase().includes("claimresponse"),
    ),
  ).toBe(true);
}

describe("AgentChatService post-action consistency (repair)", () => {
  it("Encounter A status chat uses refreshed post-submit episode for content and citations", async () => {
    const store = tempStore();
    const preSubmit = structuredClone(store.getEpisode(ENCOUNTER_A)!);
    expect(preSubmit.submissionReceiptId).toBeNull();
    expect(preSubmit.resolutionState).not.toBe("monitoring");

    await submitEncounterA(store);

    const lagged = withLaggedFirstRead(store, ENCOUNTER_A, preSubmit);
    const actions = new ActionService(lagged);

    let chatLockDepth = 0;
    let actionWhileChatLock = false;
    const originalLock = lagged.withMutationLock.bind(lagged);
    lagged.withMutationLock = async <T>(fn: () => Promise<T>) =>
      originalLock(async () => {
        chatLockDepth += 1;
        try {
          return await fn();
        } finally {
          chatLockDepth -= 1;
        }
      });

    const originalCreate = actions.createProposal.bind(actions);
    const originalRefresh = actions.refreshPayerStatus.bind(actions);
    const createProposalCalls: string[] = [];
    const refreshCalls: string[] = [];
    actions.createProposal = async (...args) => {
      createProposalCalls.push("createProposal");
      if (chatLockDepth > 0) actionWhileChatLock = true;
      return originalCreate(...args);
    };
    actions.refreshPayerStatus = async (...args) => {
      refreshCalls.push("refreshPayerStatus");
      if (chatLockDepth > 0) actionWhileChatLock = true;
      return originalRefresh(...args);
    };

    const chat = createAgentChatService(lagged, actions);
    const result = await chat.handleChat({
      episodeId: ENCOUNTER_A,
      message: "What is the current status?",
      clientRequestId: "cr-status-after-submit",
    });

    expect(result.idempotent).toBe(false);
    expectSubmittedStatusAnswer(
      result.assistantMessage.content,
      result.assistantMessage.citations,
    );
    expect(createProposalCalls).toHaveLength(0);
    expect(refreshCalls).toHaveLength(0);
    expect(actionWhileChatLock).toBe(false);

    const persisted = lagged.getEpisode(ENCOUNTER_A)!;
    expect(persisted.conversation ?? []).toHaveLength(2);
    const convEvents = lagged
      .getSnapshot()
      .events.filter((e) => e.type === "conversation.message.appended");
    expect(convEvents).toHaveLength(2);
  });

  it("final-lock idempotency recheck appends no duplicate messages or events", async () => {
    const store = tempStore();
    await submitEncounterA(store);

    const chat = createAgentChatService(store, new ActionService(store));
    const first = await chat.handleChat({
      episodeId: ENCOUNTER_A,
      message: "What is the current status?",
      clientRequestId: "cr-idem-final",
    });
    expect(first.idempotent).toBe(false);

    const afterFirst = store.getEpisode(ENCOUNTER_A)!;
    const conversationLen = (afterFirst.conversation ?? []).length;
    const eventLen = store
      .getSnapshot()
      .events.filter((e) => e.type === "conversation.message.appended").length;

    // Lagged initial read hides the committed turn so the early idempotency
    // check misses; the final-lock reload must still short-circuit.
    const withoutTurn = structuredClone(afterFirst);
    withoutTurn.conversation = [];
    const lagged = withLaggedFirstRead(store, ENCOUNTER_A, withoutTurn);
    const second = await createAgentChatService(
      lagged,
      new ActionService(lagged),
    ).handleChat({
      episodeId: ENCOUNTER_A,
      message: "What is the current status?",
      clientRequestId: "cr-idem-final",
    });

    expect(second.idempotent).toBe(true);
    expect(second.assistantMessage.id).toBe(first.assistantMessage.id);
    expect(second.userMessage.id).toBe(first.userMessage.id);
    expect((lagged.getEpisode(ENCOUNTER_A)!.conversation ?? []).length).toBe(
      conversationLen,
    );
    expect(
      lagged
        .getSnapshot()
        .events.filter((e) => e.type === "conversation.message.appended").length,
    ).toBe(eventLen);
  });

  it("BFF status intent still grounds content and citations from the refreshed episode", async () => {
    // Submit under synthetic mode, then project the post-submit episode into a
    // BFF-mode store so chat classification is intent-only.
    const synthetic = tempStore("synthetic");
    const submitted = await submitEncounterA(synthetic);
    const preSubmit = structuredClone(tempStore("synthetic").getEpisode(ENCOUNTER_A)!);

    const store = tempStore("bff");
    await store.beginMutation();
    store.replaceEpisode({
      ...submitted,
      conversation: [],
    });
    await store.commit();

    const lagged = withLaggedFirstRead(store, ENCOUNTER_A, preSubmit);
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href.endsWith("v1/threads") && init?.method === "POST") {
          return new Response(JSON.stringify({ thread_id: "thr_status_1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (href.includes("/runs") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              run_id: "run_status_1",
              thread_id: "thr_status_1",
              client_request_id: "cr-bff-status",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("/events")) {
          const event = {
            contract_version: "v1",
            event_id: "evt-mrc-status",
            run_id: "run_status_1",
            attempt_id: "att_1",
            origin: "runtime",
            attempt_sequence: 1,
            run_event_index: 1,
            event_type: "model_response_completed",
            occurred_at: "2026-08-01T00:00:00.000Z",
            run_state: "active",
            needs_reconciliation: false,
            payload: {
              model_call_id: "mc_status",
              // Closed classifier shape only. Wrong suggestedActionType must
              // still be ignored by server-owned domain grounding.
              assistant_content: JSON.stringify({
                intent: "status",
                suggestedActionType: "submit_claim",
              }),
            },
          };
          return new Response(sseFrame(event, 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });

    const result = await createAgentChatService(
      lagged,
      new ActionService(lagged, bff),
      bff,
    ).handleChat({
      episodeId: ENCOUNTER_A,
      message: "What is the current status?",
      clientRequestId: "cr-bff-status",
    });

    expect(result.assistantMessage.intent).toBe("status");
    expectSubmittedStatusAnswer(
      result.assistantMessage.content,
      result.assistantMessage.citations,
    );
    expect(result.assistantMessage.content).not.toContain("model hallucination");
    expect(result.proposalCreated).toBe(false);
  });
});
