import type { ClaimEpisode, PrimaryBucket, OverlayFlag } from "./types";
import { evaluateDiscrepancies } from "./discrepancy";
import { isVerifiedPaid } from "./verified-paid";
import { getDemoClock, isAfter } from "./clock";

export function selectPrimaryBucket(episode: ClaimEpisode): PrimaryBucket {
  if (isVerifiedPaid(episode)) return "reconciled_or_closed";

  if (
    episode.chargeState === "ready" &&
    episode.transportState === "unsent" &&
    !episode.claimId
  ) {
    return "ready_to_submit";
  }

  if (
    episode.encounterState !== "note_signed" ||
    episode.chargeState === "uncoded" ||
    episode.chargeState === "coding_blocked"
  ) {
    if (!episode.claimId) return "needs_claim";
  }

  if (episode.transportState === "clearinghouse_rejected") {
    return "rejected_before_adjudication";
  }

  if (
    episode.adjudicationState === "denied" &&
    (episode.resolutionState === "investigating" ||
      episode.resolutionState === "approval_required" ||
      episode.resolutionState === "reprocessing" ||
      episode.resolutionState === "waiting_on_payer" ||
      episode.resolutionState === "appealed")
  ) {
    return "denied_under_resolution";
  }

  if (episode.adjudicationState === "denied") {
    return "action_required";
  }

  if (
    (episode.adjudicationState === "paid" || episode.remittanceState === "received") &&
    episode.postingState !== "reconciled"
  ) {
    return "paid_needs_posting";
  }

  if (episode.adjudicationState === "info_requested") {
    return "action_required";
  }

  if (
    episode.transportState === "sent" ||
    episode.transportState === "clearinghouse_received" ||
    episode.transportState === "payer_delivered" ||
    episode.adjudicationState === "accepted_for_processing" ||
    episode.adjudicationState === "pending"
  ) {
    return "awaiting_payer";
  }

  if (episode.claimId && episode.transportState === "unsent") {
    return "ready_to_submit";
  }

  if (!episode.claimId) return "needs_claim";

  return "awaiting_payer";
}

export function selectOverlays(
  episode: ClaimEpisode,
  now = getDemoClock(),
): OverlayFlag[] {
  const flags = new Set<OverlayFlag>();
  const discrepancies = episode.discrepancies.length
    ? episode.discrepancies
    : evaluateDiscrepancies(episode, now);

  if (discrepancies.some((d) => d.ruleId === "status_conflict")) {
    flags.add("source_discrepancy");
  }
  if (
    discrepancies.some((d) => d.ruleId === "status_stale") ||
    (episode.nextFollowUpAt && isAfter(now, episode.nextFollowUpAt))
  ) {
    flags.add("follow_up_due");
  }
  if (
    episode.resolutionState === "approval_required" ||
    episode.proposal !== null
  ) {
    flags.add("approval_required");
  }

  return [...flags];
}

export function ageInDays(episode: ClaimEpisode, now = getDemoClock()): number {
  const start = episode.dateOfService;
  const ms = new Date(now).getTime() - new Date(`${start}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}
