import type { ClaimEpisode } from "./types";

const AMOUNT_TOLERANCE = 0.01;

export function amountsMatch(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= AMOUNT_TOLERANCE;
}

/**
 * Verified paid requires matching remittance evidence AND reconciled PMS posting.
 * Payer-reported paid, submitted, accepted, or reprocessed alone is insufficient.
 * Settlement/bank state is intentionally not required in this demo.
 */
export function isVerifiedPaid(episode: ClaimEpisode): boolean {
  if (episode.remittanceState !== "received") return false;
  if (episode.postingState !== "reconciled") return false;

  const controlOk =
    !!episode.claimControlNumber &&
    !!episode.remittanceControlNumber &&
    episode.claimControlNumber === episode.remittanceControlNumber;

  if (!controlOk && episode.claimId) {
    // Fallback: remittance evidence explicitly linked by claim identity.
    const remittanceLinked = episode.observations.some(
      (o) =>
        o.source === "remittance" &&
        o.evidenceReference.includes(episode.claimId!),
    );
    if (!remittanceLinked) return false;
  } else if (!controlOk) {
    return false;
  }

  const paid = episode.financial.paid;
  const posted = episode.financial.posted;
  if (!amountsMatch(paid, posted)) return false;

  const hasRemittanceEvidence = episode.evidence.some(
    (e) => e.kind === "raw_835" || e.kind === "era_pdf",
  );
  const hasPostingEvidence = episode.observations.some(
    (o) => o.source === "posting" && o.normalizedStatus === "reconciled",
  );

  return hasRemittanceEvidence && hasPostingEvidence;
}
