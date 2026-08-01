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
