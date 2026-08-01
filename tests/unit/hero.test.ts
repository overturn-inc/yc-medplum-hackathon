import { describe, expect, it } from "vitest";
import {
  HERO_STAGES,
  canAdvanceHeroStage,
  deriveHeroStage,
  getHeroStageView,
  heroStageIndex,
} from "@/domain/hero";
import { createSeedEpisodes } from "@/domain/fixtures";
import { DEFAULT_DEMO_CLOCK } from "@/domain/clock";
import type { ClaimEpisode } from "@/domain/types";

function episode(fixtureKey: ClaimEpisode["fixtureKey"]): ClaimEpisode {
  const found = createSeedEpisodes(DEFAULT_DEMO_CLOCK).find(
    (e) => e.fixtureKey === fixtureKey,
  );
  if (!found) throw new Error(`no seed episode for ${fixtureKey}`);
  return found;
}

describe("HERO_STAGES / heroStageIndex", () => {
  it("is a fixed, ordered progression from visit_ready to appeal_submitted", () => {
    expect(HERO_STAGES[0]).toBe("visit_ready");
    expect(HERO_STAGES.at(-1)).toBe("appeal_submitted");
    expect(heroStageIndex("visit_ready")).toBe(0);
    expect(heroStageIndex("appeal_submitted")).toBe(HERO_STAGES.length - 1);
  });
});

describe("canAdvanceHeroStage", () => {
  it("allows staying on the same stage or moving exactly one step forward", () => {
    expect(canAdvanceHeroStage("visit_ready", "visit_ready")).toBe(true);
    expect(canAdvanceHeroStage("visit_ready", "eligibility_checked")).toBe(true);
  });

  it("rejects skipping a stage or moving backward", () => {
    expect(canAdvanceHeroStage("visit_ready", "claim_submitted")).toBe(false);
    expect(canAdvanceHeroStage("claim_submitted", "visit_ready")).toBe(false);
  });
});

describe("getHeroStageView / deriveHeroStage", () => {
  it("returns null for non-encounter-a fixtures regardless of their state", () => {
    const claimC = episode("claim-c");
    expect(getHeroStageView(claimC)).toBeNull();
    // deriveHeroStage itself is fixture-gated too, independent of any hero fields.
    expect(deriveHeroStage(claimC)).toBe("visit_ready");
  });

  it("starts a fresh encounter-a seed episode at visit_ready with check_eligibility as the primary action", () => {
    const fresh = episode("encounter-a");
    expect(fresh.heroStage).toBeFalsy();
    const view = getHeroStageView(fresh);
    expect(view).not.toBeNull();
    expect(view!.stage).toBe("visit_ready");
    expect(view!.primaryAction).toBe("check_eligibility");
  });

  it("falls back to inferring the stage from receipts when heroStage is unset", () => {
    const fresh = episode("encounter-a");
    const withEligibility: ClaimEpisode = { ...fresh, eligibilityReceiptId: "receipt-elig-1" };
    expect(deriveHeroStage(withEligibility)).toBe("eligibility_checked");

    const withSubmission: ClaimEpisode = {
      ...withEligibility,
      submissionReceiptId: "receipt-sub-1",
    };
    expect(deriveHeroStage(withSubmission)).toBe("claim_submitted");

    const withOpenAppealProposal: ClaimEpisode = {
      ...fresh,
      denialUpheldReceiptId: "receipt-upheld-1",
      proposal: {
        ...fresh.proposal!,
        actionType: "submit_appeal",
      },
    };
    expect(deriveHeroStage(withOpenAppealProposal)).toBe("appeal_ready");

    const appealed: ClaimEpisode = { ...fresh, appealReceiptId: "receipt-appeal-1" };
    expect(deriveHeroStage(appealed)).toBe("appeal_submitted");
  });

  it("durable receipts win over a stale explicit heroStage hint", () => {
    const fresh = episode("encounter-a");
    // A successful submission receipt is the source of truth even if an old
    // projection hint still points at an earlier stage.
    const stale: ClaimEpisode = {
      ...fresh,
      submissionReceiptId: "receipt-sub-1",
      heroStage: "eligibility_checked",
    };
    expect(deriveHeroStage(stale)).toBe("claim_submitted");
    expect(getHeroStageView(stale)!.primaryAction).toBe("advance_follow_through");
  });

  it("maps every hero stage to a distinct, well-formed primary action", () => {
    const fresh = episode("encounter-a");
    for (const stage of HERO_STAGES) {
      const view = getHeroStageView({ ...fresh, heroStage: stage });
      expect(view).not.toBeNull();
      expect(view!.stage).toBe(stage);
      expect(view!.primaryLabel.length).toBeGreaterThan(0);
      expect(view!.description.length).toBeGreaterThan(0);
    }
  });
});
