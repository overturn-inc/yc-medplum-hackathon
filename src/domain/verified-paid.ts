import type { ClaimEpisode, EvidenceItem, SourceObservation } from "./types";

const AMOUNT_TOLERANCE = 0.01;

export function amountsMatch(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= AMOUNT_TOLERANCE;
}

export interface VerifiedPaidEvidence {
  /** Independent ERA/835 artifact proving the payer's remittance. */
  remittanceEvidence: EvidenceItem;
  /** Source observation confirming the remittance was received. */
  remittanceObservation: SourceObservation;
  /** Independent PMS posting receipt, separate from the remittance artifact. */
  postingEvidence: EvidenceItem;
  /** Source observation confirming the PMS reconciled the posting. */
  postingObservation: SourceObservation;
}

function latestBySourceAndStatus(
  observations: SourceObservation[],
  source: SourceObservation["source"],
  normalizedStatus: string,
): SourceObservation | undefined {
  return observations
    .filter((o) => o.source === source && o.normalizedStatus === normalizedStatus)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

/**
 * Verified paid requires two INDEPENDENT pieces of evidence plus an exact
 * identifier match and amount match. Throws a descriptive error identifying
 * the missing/failed requirement; on success returns the exact evidence
 * items and observations relied upon so callers (and tests) can cite them.
 *
 * Deliberately does NOT consider Claim.status, ClaimResponse.status/outcome,
 * or adjudicationState/resolutionState: those reflect payer-reported or
 * PMS-reported status only, never proof of an independently reconciled
 * payment. PaymentReconciliation may support remittance linkage but is never
 * accepted as PMS posting evidence.
 */
export function assertVerifiedPaidEvidence(episode: ClaimEpisode): VerifiedPaidEvidence {
  const remittanceEvidence = episode.evidence.find(
    (e) => e.kind === "raw_835" || e.kind === "era_pdf",
  );
  if (!remittanceEvidence) {
    throw new Error(
      "Verified paid requires independent remittance evidence (raw_835 or era_pdf DocumentReference)",
    );
  }

  const remittanceObservation = latestBySourceAndStatus(
    episode.observations,
    "remittance",
    "received",
  );
  if (!remittanceObservation) {
    throw new Error(
      "Verified paid requires a remittance observation with normalizedStatus 'received'",
    );
  }

  const postingObservation = latestBySourceAndStatus(
    episode.observations,
    "posting",
    "reconciled",
  );
  if (!postingObservation) {
    throw new Error(
      "Verified paid requires a posting observation with normalizedStatus 'reconciled'",
    );
  }

  // PaymentReconciliation may support remittance linkage but must never be
  // accepted as PMS posting proof; posting must cite a separate DocumentReference.
  if (!postingObservation.evidenceReference.startsWith("DocumentReference/")) {
    throw new Error(
      "Verified paid requires PMS posting proof from a DocumentReference (PMS posting receipt); PaymentReconciliation, Claim, or ClaimResponse references are not accepted",
    );
  }

  const postingEvidence = episode.evidence.find(
    (e) =>
      (e.kind === "pms_posting" || e.kind === "receipt") &&
      e.reference === postingObservation.evidenceReference,
  );
  if (!postingEvidence) {
    throw new Error(
      "Verified paid requires an independent PMS posting receipt DocumentReference evidence item matching the posting observation",
    );
  }

  if (postingEvidence.reference === remittanceEvidence.reference) {
    throw new Error(
      "Verified paid requires posting evidence to be independent from remittance evidence, not the same artifact",
    );
  }

  const controlNumberMatch =
    !!episode.claimControlNumber &&
    !!episode.remittanceControlNumber &&
    episode.claimControlNumber === episode.remittanceControlNumber;
  if (!controlNumberMatch) {
    throw new Error(
      "Verified paid requires an exact match between claimControlNumber and remittanceControlNumber",
    );
  }

  if (!amountsMatch(episode.financial.paid, episode.financial.posted)) {
    throw new Error(
      "Verified paid requires the paid amount to match the posted amount within tolerance",
    );
  }

  return {
    remittanceEvidence,
    remittanceObservation,
    postingEvidence,
    postingObservation,
  };
}

/**
 * Verified paid requires matching remittance evidence AND reconciled PMS
 * posting from an independent DocumentReference, with an exact control
 * number match and matching amounts. Payer-reported paid, submitted,
 * accepted, or reprocessed alone is insufficient, and PaymentReconciliation
 * alone never counts as posting proof.
 */
export function isVerifiedPaid(episode: ClaimEpisode): boolean {
  try {
    assertVerifiedPaidEvidence(episode);
    return true;
  } catch {
    return false;
  }
}
