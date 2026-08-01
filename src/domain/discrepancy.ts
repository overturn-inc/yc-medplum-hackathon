import type {
  AdjudicationState,
  ClaimEpisode,
  DiscrepancyFinding,
  ObservationSource,
  SourceObservation,
} from "./types";
import { getDemoClock, isAfter } from "./clock";

const ADJUDICATION_VALUES = new Set<string>([
  "not_found",
  "accepted_for_processing",
  "pending",
  "info_requested",
  "denied",
  "partial",
  "paid",
  "processing",
]);

function latestBySource(
  observations: SourceObservation[],
  source: ObservationSource,
): SourceObservation | undefined {
  return observations
    .filter((o) => o.source === source)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

function asAdjudication(status: string): AdjudicationState | "processing" | null {
  if (status === "processing") return "processing";
  if (ADJUDICATION_VALUES.has(status)) return status as AdjudicationState;
  return null;
}

function adjudicationConflicts(
  pms: string,
  payer: string,
): boolean {
  if (pms === payer) return false;
  const pmsAdj = asAdjudication(pms);
  const payerAdj = asAdjudication(payer);
  if (!pmsAdj || !payerAdj) return false;
  // Explicit conflict pairs used by the demo and product rules.
  if (pmsAdj === "processing" && payerAdj === "denied") return true;
  if (pmsAdj === "accepted_for_processing" && payerAdj === "denied") return true;
  if (pmsAdj === "pending" && payerAdj === "denied") return true;
  if (pmsAdj === "paid" && payerAdj === "denied") return true;
  if (pmsAdj === "processing" && payerAdj === "paid") return true;
  if (pmsAdj === "accepted_for_processing" && payerAdj === "paid") return true;
  return false;
}

export function detectStatusConflict(
  episode: ClaimEpisode,
): DiscrepancyFinding | null {
  const pms = latestBySource(episode.observations, "pms");
  const payer = latestBySource(episode.observations, "payer");
  if (!pms || !payer) return null;
  if (!isAfter(payer.observedAt, pms.observedAt) && payer.observedAt !== pms.observedAt) {
    // Prefer cases where payer evidence is at least as new, or explicitly newer.
    if (new Date(payer.observedAt).getTime() < new Date(pms.observedAt).getTime()) {
      return null;
    }
  }
  if (!adjudicationConflicts(pms.normalizedStatus, payer.normalizedStatus)) {
    return null;
  }

  return {
    ruleId: "status_conflict",
    episodeId: episode.id,
    summary: `PMS reports ${pms.normalizedStatus} while payer reports ${payer.normalizedStatus}`,
    comparedSources: [
      {
        source: "pms",
        observedAt: pms.observedAt,
        normalizedStatus: pms.normalizedStatus,
        evidenceReference: pms.evidenceReference,
      },
      {
        source: "payer",
        observedAt: payer.observedAt,
        normalizedStatus: payer.normalizedStatus,
        evidenceReference: payer.evidenceReference,
      },
    ],
    evidenceReferences: [pms.evidenceReference, payer.evidenceReference],
  };
}

export function detectStatusStale(
  episode: ClaimEpisode,
  now = getDemoClock(),
): DiscrepancyFinding | null {
  const acceptedLike =
    episode.adjudicationState === "accepted_for_processing" ||
    episode.adjudicationState === "pending" ||
    episode.transportState === "payer_delivered";

  if (!acceptedLike) return null;
  if (episode.adjudicationState === "denied" || episode.adjudicationState === "paid") {
    return null;
  }
  if (episode.remittanceState === "received") return null;

  const followUp = episode.nextFollowUpAt;
  if (!followUp || !isAfter(now, followUp)) return null;

  const payer = latestBySource(episode.observations, "payer");
  const remittance = latestBySource(episode.observations, "remittance");
  const latestPayerOrRemit = [payer, remittance]
    .filter(Boolean)
    .sort((a, b) => (b!.observedAt.localeCompare(a!.observedAt)))[0];

  if (latestPayerOrRemit && isAfter(latestPayerOrRemit.observedAt, followUp)) {
    return null;
  }

  const clearinghouse = latestBySource(episode.observations, "clearinghouse");
  const compared = [
    clearinghouse && {
      source: "clearinghouse" as const,
      observedAt: clearinghouse.observedAt,
      normalizedStatus: clearinghouse.normalizedStatus,
      evidenceReference: clearinghouse.evidenceReference,
    },
    payer && {
      source: "payer" as const,
      observedAt: payer.observedAt,
      normalizedStatus: payer.normalizedStatus,
      evidenceReference: payer.evidenceReference,
    },
  ].filter(Boolean) as DiscrepancyFinding["comparedSources"];

  return {
    ruleId: "status_stale",
    episodeId: episode.id,
    summary: `Accepted or processing with follow-up due at ${followUp} and no newer payer or remittance observation`,
    comparedSources: compared,
    evidenceReferences: compared.map((c) => c.evidenceReference),
  };
}

export function detectPaymentUnverified(
  episode: ClaimEpisode,
): DiscrepancyFinding | null {
  const payerPaid =
    episode.adjudicationState === "paid" ||
    episode.observations.some(
      (o) =>
        (o.source === "payer" || o.source === "remittance") &&
        o.normalizedStatus === "paid",
    );

  if (!payerPaid) return null;

  const remittanceOk = episode.remittanceState === "received";
  const postingOk = episode.postingState === "reconciled";
  if (remittanceOk && postingOk) return null;

  const remittance = latestBySource(episode.observations, "remittance");
  const posting = latestBySource(episode.observations, "posting");

  return {
    ruleId: "payment_unverified",
    episodeId: episode.id,
    summary: "Payer or ERA indicates paid without matching remittance normalization and posting reconciliation",
    comparedSources: [
      remittance && {
        source: "remittance" as const,
        observedAt: remittance.observedAt,
        normalizedStatus: remittance.normalizedStatus,
        evidenceReference: remittance.evidenceReference,
      },
      posting && {
        source: "posting" as const,
        observedAt: posting.observedAt,
        normalizedStatus: posting.normalizedStatus,
        evidenceReference: posting.evidenceReference,
      },
    ].filter(Boolean) as DiscrepancyFinding["comparedSources"],
    evidenceReferences: [remittance?.evidenceReference, posting?.evidenceReference].filter(
      Boolean,
    ) as string[],
  };
}

export function evaluateDiscrepancies(
  episode: ClaimEpisode,
  now = getDemoClock(),
): DiscrepancyFinding[] {
  return [
    detectStatusConflict(episode),
    detectStatusStale(episode, now),
    detectPaymentUnverified(episode),
  ].filter(Boolean) as DiscrepancyFinding[];
}
