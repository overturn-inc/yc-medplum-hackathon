import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createStediClient,
  createStediMockEligibilityRequest,
} from "@/adapters/clearinghouse/stedi";
import { ActionService } from "@/server/actions";
import { assertActionRateLimit, ToolJobRateLimitError } from "@/server/tool-job-ledger";
import { LocalEventStore } from "@/server/store";

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-eligibility-"));
  return new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
}

describe("Stedi eligibility never touches the professional claims rail", () => {
  it("checkEligibility only ever calls the eligibility path, never professional claims", async () => {
    const calledUrls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      calledUrls.push(String(url));
      return new Response(
        JSON.stringify({
          id: "ec_test_scope",
          meta: { applicationMode: "test" },
          tradingPartnerServiceId: "87726",
          errors: [],
          benefitsInformation: [
            { code: "1", name: "Active Coverage", planCoverage: "CHOICE PLUS" },
          ],
          x12: "ISA*synthetic-271",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = createStediClient({
      apiKey: "test_secret",
      mode: "test",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.checkEligibility(createStediMockEligibilityRequest());

    expect(calledUrls).toHaveLength(1);
    expect(calledUrls[0]).toContain("/eligibility/v3");
    expect(calledUrls.some((u) => u.includes("professionalclaims"))).toBe(false);
  });
});

describe("eligibility durable evidence (ActionService.recordEligibilityCheck)", () => {
  const result = {
    checkId: "ec_test_1",
    applicationMode: "test",
    activeCoverage: true,
    activeBenefitCount: 1,
    planNames: ["CHOICE PLUS"],
    hasRaw271: true,
  };

  it("persists a normalized receipt, hero stage, and evidence -- never raw X12", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const before = store.getEpisode("episode-encounter-a")!;
    expect(before.eligibilityReceiptId).toBeFalsy();

    const outcome = await actions.recordEligibilityCheck("episode-encounter-a", result);
    expect(outcome.idempotent).toBe(false);
    expect(outcome.receiptId).toBeTruthy();

    const episode = store.getEpisode("episode-encounter-a")!;
    expect(episode.eligibilityReceiptId).toBe(outcome.receiptId);
    expect(episode.eligibilitySummary).toEqual(result);
    expect(episode.coverageActive).toBe(true);
    expect(episode.heroStage).toBe("eligibility_checked");
    expect(
      episode.evidence.some(
        (e) => e.kind === "receipt" && e.reference === "Coverage/eligibility-ec_test_1",
      ),
    ).toBe(true);
    expect(episode.activities.some((a) => a.kind === "eligibility.checked")).toBe(true);
    expect(
      store.getSnapshot().events.filter((e) => e.type === "eligibility.checked"),
    ).toHaveLength(1);

    // Never persists the raw 271; only checkId/applicationMode/coverage/benefit-count/plan-names/hasRaw271 flag.
    const serialized = JSON.stringify(episode);
    expect(serialized).not.toContain("ISA*synthetic-271");
  });

  it("is idempotent: a second call returns the existing receipt without a new event or duplicated evidence", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const first = await actions.recordEligibilityCheck("episode-encounter-a", result);

    const second = await actions.recordEligibilityCheck("episode-encounter-a", {
      ...result,
      checkId: "ec_test_should_be_ignored",
    });
    expect(second.idempotent).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);

    const episode = store.getEpisode("episode-encounter-a")!;
    expect(episode.eligibilitySummary?.checkId).toBe("ec_test_1");
    expect(episode.evidence.filter((e) => e.kind === "receipt")).toHaveLength(1);
    expect(
      store.getSnapshot().events.filter((e) => e.type === "eligibility.checked"),
    ).toHaveLength(1);
  });

  it("rejects fixtures other than encounter-a", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    await expect(
      actions.recordEligibilityCheck("episode-claim-c", result),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.getEpisode("episode-claim-c")!.eligibilityReceiptId).toBeFalsy();
  });
});

describe("eligibility rate limiting", () => {
  it("allows up to the configured session limit and then rejects", () => {
    const sessionId = `test-session-${randomUUID()}`;
    for (let i = 0; i < 8; i += 1) {
      expect(() => assertActionRateLimit("eligibility", sessionId)).not.toThrow();
    }
    expect(() => assertActionRateLimit("eligibility", sessionId)).toThrow(
      ToolJobRateLimitError,
    );
  });
});
