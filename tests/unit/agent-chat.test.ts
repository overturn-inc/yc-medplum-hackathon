import { describe, expect, it } from "vitest";
import { answerChatMessage, classifyIntent } from "@/domain/agent-chat";
import { createSeedEpisodes } from "@/domain/fixtures";
import { DEFAULT_DEMO_CLOCK } from "@/domain/clock";

describe("classifyIntent (P1 intent parsing)", () => {
  it("classifies explicit action-request phrasing as request_action", () => {
    expect(classifyIntent("Submit this claim for me")).toBe("request_action");
    expect(classifyIntent("Please send this documentation")).toBe("request_action");
    expect(classifyIntent("send this documentation")).toBe("request_action");
    expect(classifyIntent("fix this rejection and resubmit")).toBe("request_action");
    expect(classifyIntent("Can you refresh the payer status?")).toBe("request_action");
    expect(classifyIntent("check the payer status")).toBe("request_action");
    expect(classifyIntent("Correct and resubmit this claim")).toBe("request_action");
    expect(classifyIntent("Request reprocessing please")).toBe("request_action");
  });

  it("classifies a payer-denial classification question as reason/status, never unsupported", () => {
    const intent = classifyIntent("Is this a payer denial?");
    expect(["reason", "status"]).toContain(intent);
    expect(intent).not.toBe("unsupported");
  });

  it("still classifies why/reason/explain phrasing as reason", () => {
    expect(classifyIntent("Why was this denied?")).toBe("reason");
    expect(classifyIntent("Explain the discrepancy")).toBe("reason");
  });

  it("falls back to unsupported only for genuinely unscripted text", () => {
    expect(classifyIntent("")).toBe("unsupported");
    expect(classifyIntent("blah blah nonsense xyz")).toBe("unsupported");
  });
});

describe("answerChatMessage claim-b read-only refresh (P1)", () => {
  const episodes = createSeedEpisodes(DEFAULT_DEMO_CLOCK);
  const claimB = episodes.find((e) => e.fixtureKey === "claim-b")!;

  it("never suggests a proposal-based action for claim-b", () => {
    const answer = answerChatMessage(claimB, "refresh the payer status");
    expect(answer.intent).toBe("request_action");
    expect(answer.suggestedActionType).toBeNull();
    expect(answer.executeReadOnlyRefresh).toBe(true);
  });

  it("free-text action requests on other fixtures only ever suggest a proposal", () => {
    const claimC = episodes.find((e) => e.fixtureKey === "claim-c")!;
    const answer = answerChatMessage(claimC, "request reprocessing");
    expect(answer.intent).toBe("request_action");
    expect(answer.suggestedActionType).toBe("request_reprocessing");
    expect(answer.executeReadOnlyRefresh).toBeUndefined();
  });
});

describe("answerChatMessage reflects completed actions", () => {
  const episodes = createSeedEpisodes(DEFAULT_DEMO_CLOCK);

  it("reports submission receipt and monitoring instead of stale readiness", () => {
    const encounter = structuredClone(
      episodes.find((e) => e.fixtureKey === "encounter-a")!,
    );
    encounter.submissionReceiptId = "receipt-submit-episode-encounter-a";
    encounter.transportState = "clearinghouse_received";
    encounter.adjudicationState = "not_found";
    encounter.resolutionState = "monitoring";
    const answer = answerChatMessage(encounter, "What is the current status?");
    expect(answer.content).toContain(encounter.submissionReceiptId);
    expect(answer.content).toContain("monitoring");
    expect(answer.content).not.toContain("ready for claim submission");
    expect(answer.suggestedActionType).toBeNull();
  });

  it("describes a completed Claim B refresh and future scheduled follow-up", () => {
    const claim = structuredClone(
      episodes.find((e) => e.fixtureKey === "claim-b")!,
    );
    claim.statusRefreshReceiptId = "receipt-status-refresh-claim-b";
    claim.lastPayerCheckAt = "2026-07-15T15:00:00.000Z";
    claim.lastVerifiedAt = "2026-07-15T15:00:00.000Z";
    claim.nextFollowUpAt = "2026-07-22T15:00:00.000Z";
    const answer = answerChatMessage(claim, "What is the current status?");
    expect(answer.content).toContain(claim.statusRefreshReceiptId);
    expect(answer.content).toContain("scheduled for 2026-07-22");
    expect(answer.content).not.toContain("was due 2026-07-22");
    expect(answer.content).toContain("did not mark the claim paid");
  });

  it("reports completed reprocessing while denial remains", () => {
    const claim = structuredClone(
      episodes.find((e) => e.fixtureKey === "claim-c")!,
    );
    claim.reprocessingReceiptId = "receipt-reprocess-episode-claim-c";
    claim.resolutionState = "reprocessing";
    claim.adjudicationState = "denied";
    claim.nextFollowUpAt = "2026-07-22T15:00:00.000Z";
    const answer = answerChatMessage(claim, "What should happen next?");
    expect(answer.content).toContain(claim.reprocessingReceiptId);
    expect(answer.content).toContain("remains denied");
    expect(answer.content).toContain("2026-07-22");
    expect(answer.suggestedActionType).toBeNull();
  });

  it("reports documentation as sent and awaiting payer", () => {
    const claim = structuredClone(
      episodes.find((e) => e.fixtureKey === "claim-e")!,
    );
    claim.documentationReceiptId = "receipt-send-documentation-episode-claim-e";
    claim.resolutionState = "waiting_on_payer";
    claim.nextFollowUpAt = "2026-07-22T15:00:00.000Z";
    const answer = answerChatMessage(claim, "What is the current status?");
    expect(answer.content).toContain(claim.documentationReceiptId);
    expect(answer.content).toContain("waiting_on_payer");
    expect(answer.content).not.toContain("has not been sent");
    expect(answer.suggestedActionType).toBeNull();
  });
});
