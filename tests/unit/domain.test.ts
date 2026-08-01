import { describe, expect, it } from "vitest";
import { createSeedEpisodes } from "@/domain/fixtures";
import { evaluateDiscrepancies } from "@/domain/discrepancy";
import { selectOverlays, selectPrimaryBucket } from "@/domain/selectors";
import { isVerifiedPaid } from "@/domain/verified-paid";
import { runPreflight, preflightReady } from "@/domain/preflight";
import { computeDashboardKpi, projectEpisodes } from "@/domain/projector";
import { DEFAULT_DEMO_CLOCK } from "@/domain/clock";

describe("projection and discrepancy (A02 A03 A11 A15 A16 A17)", () => {
  const episodes = createSeedEpisodes(DEFAULT_DEMO_CLOCK);

  it("keeps primary funnel mutually exclusive and equal to episode count", () => {
    const kpi = computeDashboardKpi(episodes);
    const total = Object.values(kpi.funnel).reduce((a, b) => a + b, 0);
    expect(total).toBe(episodes.length);
    expect(kpi.overlays.source_discrepancy).toBeGreaterThan(0);
    expect(total).not.toBe(
      total + kpi.overlays.source_discrepancy + kpi.overlays.follow_up_due,
    );
  });

  it("detects Claim C status conflict with authorization evidence", () => {
    const claimC = episodes.find((e) => e.fixtureKey === "claim-c")!;
    const findings = evaluateDiscrepancies(claimC);
    const conflict = findings.find((f) => f.ruleId === "status_conflict");
    expect(conflict).toBeTruthy();
    expect(conflict!.comparedSources[0]?.source).toBe("pms");
    expect(conflict!.comparedSources[1]?.source).toBe("payer");
    expect(claimC.evidence.some((e) => e.kind === "authorization")).toBe(true);
    expect(selectPrimaryBucket(claimC)).toBe("denied_under_resolution");
    expect(selectOverlays(claimC)).toContain("source_discrepancy");
  });

  it("marks accepted-no-ERA as follow-up due", () => {
    const claimB = episodes.find((e) => e.fixtureKey === "claim-b")!;
    const findings = evaluateDiscrepancies(claimB);
    expect(findings.some((f) => f.ruleId === "status_stale")).toBe(true);
    expect(selectOverlays(claimB)).toContain("follow_up_due");
  });

  it("verified paid requires remittance and matching posting", () => {
    const claimF = episodes.find((e) => e.fixtureKey === "claim-f")!;
    expect(isVerifiedPaid(claimF)).toBe(true);

    const missingPosting = {
      ...claimF,
      postingState: "unposted" as const,
      financial: { ...claimF.financial, posted: null },
      observations: claimF.observations.filter((o) => o.source !== "posting"),
    };
    expect(isVerifiedPaid(missingPosting)).toBe(false);

    const missingRemittance = {
      ...claimF,
      remittanceState: "none" as const,
      evidence: claimF.evidence.filter((e) => e.kind !== "raw_835" && e.kind !== "era_pdf"),
    };
    expect(isVerifiedPaid(missingRemittance)).toBe(false);
  });

  it("reprocessed/denied claim is never verified paid", () => {
    const claimC = episodes.find((e) => e.fixtureKey === "claim-c")!;
    const reprocessed = {
      ...claimC,
      resolutionState: "reprocessing" as const,
      reprocessingReceiptId: "receipt-x",
    };
    expect(isVerifiedPaid(reprocessed)).toBe(false);
    expect(selectPrimaryBucket(reprocessed)).not.toBe("reconciled_or_closed");
  });

  it("encounter A preflight passes all required checks", () => {
    const encounterA = episodes.find((e) => e.fixtureKey === "encounter-a")!;
    const checks = runPreflight(encounterA);
    expect(preflightReady(checks)).toBe(true);
    expect(checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "encounter_completed",
        "final_note",
        "active_coverage",
        "provider",
        "diagnosis",
        "service_line",
        "charge",
      ]),
    );
  });

  it("projects fixture-derived KPI values", () => {
    const kpi = computeDashboardKpi(episodes);
    expect(kpi.visitsToday).toBe(1);
    expect(kpi.readyToSubmit).toBe(2);
    expect(kpi.needsAttention).toBe(4);
    expect(kpi.verifiedPaidMtd).toBe(1);
    expect(kpi.funnel.denied_under_resolution).toBe(1);
    expect(kpi.funnel.rejected_before_adjudication).toBe(1);
    expect(kpi.overlays.follow_up_due).toBeGreaterThanOrEqual(1);
    const views = projectEpisodes(episodes);
    expect(views).toHaveLength(7);
  });
});
