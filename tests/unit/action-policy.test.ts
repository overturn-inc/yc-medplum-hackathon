import { describe, expect, it } from "vitest";
import { assertActionAllowed, isActionAllowed } from "@/domain/action-policy";
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

describe("assertActionAllowed (P0 server-owned action policy)", () => {
  it("denies every mutation on claim-f (verified paid) regardless of actionType", () => {
    const claimF = episode("claim-f");
    for (const actionType of [
      "submit_claim",
      "request_reprocessing",
      "correct_and_resubmit",
      "send_documentation",
    ] as const) {
      expect(() => assertActionAllowed(claimF, actionType)).toThrow();
      expect(isActionAllowed(claimF, actionType)).toBe(false);
    }
  });

  it("denies mutations on closed/reconciled/verified-paid episodes even off-fixture", () => {
    const claimC = episode("claim-c");
    const closed: ClaimEpisode = { ...claimC, resolutionState: "closed" };
    expect(() => assertActionAllowed(closed, "request_reprocessing")).toThrow();

    const reconciled: ClaimEpisode = { ...claimC, postingState: "reconciled" };
    expect(() => assertActionAllowed(reconciled, "request_reprocessing")).toThrow();
  });

  it("encounter-a/claim-a only allow submit_claim while unsent with no receipt", () => {
    const encounterA = episode("encounter-a");
    expect(() => assertActionAllowed(encounterA, "submit_claim")).not.toThrow();
    expect(() => assertActionAllowed(encounterA, "request_reprocessing")).toThrow();

    const alreadySubmitted: ClaimEpisode = {
      ...encounterA,
      submissionReceiptId: "receipt-x",
    };
    expect(() => assertActionAllowed(alreadySubmitted, "submit_claim")).toThrow();
  });

  it("claim-b rejects every proposal-shaped action, including its own default", () => {
    const claimB = episode("claim-b");
    for (const actionType of [
      "submit_claim",
      "request_reprocessing",
      "correct_and_resubmit",
      "send_documentation",
      "refresh_payer_status",
    ] as const) {
      expect(() => assertActionAllowed(claimB, actionType)).toThrow();
    }
  });

  it("claim-c only allows request_reprocessing while denied with no reprocessing receipt", () => {
    const claimC = episode("claim-c");
    expect(() => assertActionAllowed(claimC, "request_reprocessing")).not.toThrow();
    expect(() => assertActionAllowed(claimC, "submit_claim")).toThrow();

    const already: ClaimEpisode = { ...claimC, reprocessingReceiptId: "receipt-x" };
    expect(() => assertActionAllowed(already, "request_reprocessing")).toThrow();
  });

  it("claim-d only allows correct_and_resubmit while clearinghouse_rejected with no correction", () => {
    const claimD = episode("claim-d");
    expect(() => assertActionAllowed(claimD, "correct_and_resubmit")).not.toThrow();

    const already: ClaimEpisode = {
      ...claimD,
      correctedFromClaimId: "CLM-D-OLD",
    };
    expect(() => assertActionAllowed(already, "correct_and_resubmit")).toThrow();
  });

  it("claim-e only allows send_documentation while info_requested with no documentation receipt", () => {
    const claimE = episode("claim-e");
    expect(() => assertActionAllowed(claimE, "send_documentation")).not.toThrow();

    const already: ClaimEpisode = { ...claimE, documentationReceiptId: "receipt-x" };
    expect(() => assertActionAllowed(already, "send_documentation")).toThrow();
  });
});
