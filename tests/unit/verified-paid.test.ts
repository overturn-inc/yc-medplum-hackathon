import { describe, expect, it } from "vitest";
import { createSeedEpisodes } from "@/domain/fixtures";
import {
  assertVerifiedPaidEvidence,
  isVerifiedPaid,
} from "@/domain/verified-paid";
import { DEFAULT_DEMO_CLOCK } from "@/domain/clock";

describe("verified paid (fail closed)", () => {
  const claimF = createSeedEpisodes(DEFAULT_DEMO_CLOCK).find(
    (e) => e.fixtureKey === "claim-f",
  )!;

  it("accepts the ground-truth paid claim with independent remittance and posting", () => {
    expect(isVerifiedPaid(claimF)).toBe(true);
    const evidence = assertVerifiedPaidEvidence(claimF);
    expect(evidence.remittanceEvidence.kind).toBe("raw_835");
    expect(evidence.postingEvidence.kind).toBe("pms_posting");
    expect(evidence.postingEvidence.reference).not.toBe(
      evidence.remittanceEvidence.reference,
    );
  });

  it("rejects when remittance evidence (raw_835/era_pdf) is missing", () => {
    const missingRemittance = {
      ...claimF,
      evidence: claimF.evidence.filter(
        (e) => e.kind !== "raw_835" && e.kind !== "era_pdf",
      ),
    };
    expect(isVerifiedPaid(missingRemittance)).toBe(false);
    expect(() => assertVerifiedPaidEvidence(missingRemittance)).toThrow(
      /independent remittance evidence/,
    );
  });

  it("rejects when the remittance observation is missing or not 'received'", () => {
    const missingRemittanceObservation = {
      ...claimF,
      observations: claimF.observations.filter((o) => o.source !== "remittance"),
    };
    expect(isVerifiedPaid(missingRemittanceObservation)).toBe(false);
    expect(() =>
      assertVerifiedPaidEvidence(missingRemittanceObservation),
    ).toThrow(/remittance observation/);
  });

  it("rejects when posting evidence (independent DocumentReference) is missing", () => {
    const missingPosting = {
      ...claimF,
      postingState: "unposted" as const,
      financial: { ...claimF.financial, posted: null },
      evidence: claimF.evidence.filter((e) => e.kind !== "pms_posting"),
      observations: claimF.observations.filter((o) => o.source !== "posting"),
    };
    expect(isVerifiedPaid(missingPosting)).toBe(false);
    expect(() => assertVerifiedPaidEvidence(missingPosting)).toThrow(
      /posting observation/,
    );
  });

  it("rejects a PaymentReconciliation reference used as PMS posting proof", () => {
    const paymentReconciliationAsPosting = {
      ...claimF,
      observations: claimF.observations.map((o) =>
        o.source === "posting"
          ? { ...o, evidenceReference: "PaymentReconciliation/payrec-claim-f" }
          : o,
      ),
    };
    expect(isVerifiedPaid(paymentReconciliationAsPosting)).toBe(false);
    expect(() =>
      assertVerifiedPaidEvidence(paymentReconciliationAsPosting),
    ).toThrow(/PMS posting proof from a DocumentReference/);
  });

  it("rejects a Claim or ClaimResponse reference used as posting proof", () => {
    for (const badReference of [
      `Claim/${claimF.claimId!.toLowerCase()}`,
      `ClaimResponse/${claimF.submissionReceiptId}`,
    ]) {
      const badPosting = {
        ...claimF,
        observations: claimF.observations.map((o) =>
          o.source === "posting" ? { ...o, evidenceReference: badReference } : o,
        ),
      };
      expect(isVerifiedPaid(badPosting)).toBe(false);
    }
  });

  it("rejects when posting evidence is the same artifact as remittance evidence", () => {
    // Force the posting evidence item to literally point at the remittance
    // artifact's reference to simulate a non-independent posting record.
    const remittanceRef = claimF.evidence.find((e) => e.kind === "raw_835")!.reference;
    const collapsed = {
      ...claimF,
      evidence: claimF.evidence.map((e) =>
        e.kind === "pms_posting" ? { ...e, reference: remittanceRef } : e,
      ),
      observations: claimF.observations.map((o) =>
        o.source === "posting" ? { ...o, evidenceReference: remittanceRef } : o,
      ),
    };
    expect(isVerifiedPaid(collapsed)).toBe(false);
    expect(() => assertVerifiedPaidEvidence(collapsed)).toThrow(
      /independent from remittance evidence/,
    );
  });

  it("rejects when claimControlNumber and remittanceControlNumber do not match", () => {
    const controlMismatch = {
      ...claimF,
      remittanceControlNumber: "CN-DIFFERENT-0000",
    };
    expect(isVerifiedPaid(controlMismatch)).toBe(false);
    expect(() => assertVerifiedPaidEvidence(controlMismatch)).toThrow(
      /exact match between claimControlNumber and remittanceControlNumber/,
    );
  });

  it("rejects when either control number is null", () => {
    expect(isVerifiedPaid({ ...claimF, claimControlNumber: null })).toBe(false);
    expect(isVerifiedPaid({ ...claimF, remittanceControlNumber: null })).toBe(
      false,
    );
  });

  it("rejects when paid and posted amounts do not match within tolerance", () => {
    const amountMismatch = {
      ...claimF,
      financial: { ...claimF.financial, posted: (claimF.financial.paid ?? 0) + 5 },
    };
    expect(isVerifiedPaid(amountMismatch)).toBe(false);
    expect(() => assertVerifiedPaidEvidence(amountMismatch)).toThrow(
      /paid amount to match the posted amount/,
    );
  });

  it("rejects when either paid or posted amount is null", () => {
    expect(
      isVerifiedPaid({
        ...claimF,
        financial: { ...claimF.financial, paid: null },
      }),
    ).toBe(false);
    expect(
      isVerifiedPaid({
        ...claimF,
        financial: { ...claimF.financial, posted: null },
      }),
    ).toBe(false);
  });

  it("never treats Claim.status or ClaimResponse.status/outcome alone as paid", () => {
    // Sanity: an episode with payer/PMS "paid"-like status strings but no
    // independent remittance+posting evidence at all must never verify.
    const statusOnly = {
      ...claimF,
      evidence: [],
      observations: [],
      postingState: "unposted" as const,
      remittanceState: "none" as const,
    };
    expect(isVerifiedPaid(statusOnly)).toBe(false);
  });
});
