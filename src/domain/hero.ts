/**
 * Guided hero claim stage machine for episode-encounter-a.
 * Stages advance only after durable connector receipts or approved mutations.
 */
import type { ClaimEpisode } from "./types";

export const HERO_STAGES = [
  "visit_ready",
  "eligibility_checked",
  "claim_submitted",
  "accepted_overdue",
  "portal_denied",
  "voice_evidence_collected",
  "reprocessing",
  "denial_upheld",
  "appeal_ready",
  "appeal_submitted",
] as const;

export type HeroStage = (typeof HERO_STAGES)[number];

export type HeroPrimaryAction =
  | "check_eligibility"
  | "submit_claim"
  | "advance_follow_through"
  | "investigate_portal"
  | "start_voice_session"
  | "request_reprocessing"
  | "recheck_denial"
  | "prepare_appeal"
  | "submit_appeal"
  | "none";

export interface HeroStageView {
  stage: HeroStage;
  label: string;
  primaryAction: HeroPrimaryAction;
  primaryLabel: string;
  description: string;
}

const STAGE_META: Record<
  HeroStage,
  Omit<HeroStageView, "stage">
> = {
  visit_ready: {
    label: "Visit complete",
    primaryAction: "check_eligibility",
    primaryLabel: "Check synthetic eligibility",
    description: "Final note signed. Confirm coverage before claim creation.",
  },
  eligibility_checked: {
    label: "Coverage confirmed",
    primaryAction: "submit_claim",
    primaryLabel: "Propose claim submission",
    description: "Active synthetic coverage is on file. Submit via simulated clearinghouse.",
  },
  claim_submitted: {
    label: "Claim submitted",
    primaryAction: "advance_follow_through",
    primaryLabel: "Advance to accepted overdue",
    description: "Simulated Stedi clearinghouse accepted the claim for processing.",
  },
  accepted_overdue: {
    label: "Accepted overdue",
    primaryAction: "investigate_portal",
    primaryLabel: "Investigate payer portal",
    description: "No remittance yet. Run constrained Northstar portal investigation.",
  },
  portal_denied: {
    label: "Portal denial",
    primaryAction: "start_voice_session",
    primaryLabel: "Start Deepgram voice session",
    description: "Portal denial conflicts with authorization. Collect scripted voice evidence.",
  },
  voice_evidence_collected: {
    label: "Voice evidence",
    primaryAction: "request_reprocessing",
    primaryLabel: "Propose reprocessing",
    description: "Portal and voice receipts exist. Prefer reprocessing before appeal.",
  },
  reprocessing: {
    label: "Reprocessing requested",
    primaryAction: "recheck_denial",
    primaryLabel: "Recheck denial on portal",
    description: "Confirm whether the synthetic denial was upheld after reprocessing.",
  },
  denial_upheld: {
    label: "Denial upheld",
    primaryAction: "prepare_appeal",
    primaryLabel: "Prepare formal appeal",
    description: "Recheck confirmed denial upheld. Build the appeal packet.",
  },
  appeal_ready: {
    label: "Appeal ready",
    primaryAction: "submit_appeal",
    primaryLabel: "Allow once to submit appeal",
    description: "Approval-gated appeal submission to the fictional Northstar portal.",
  },
  appeal_submitted: {
    label: "Appeal submitted",
    primaryAction: "none",
    primaryLabel: "Complete",
    description: "Appeal confirmation, follow-up, Provenance and AuditEvent are on file.",
  },
};

export function deriveHeroStage(episode: ClaimEpisode): HeroStage {
  if (episode.fixtureKey !== "encounter-a") {
    return "visit_ready";
  }
  if (episode.appealReceiptId || episode.resolutionState === "appealed") {
    return "appeal_submitted";
  }
  if (episode.proposal?.actionType === "submit_appeal") {
    return "appeal_ready";
  }
  if (episode.denialUpheldReceiptId) {
    return "denial_upheld";
  }
  if (episode.reprocessingReceiptId || episode.resolutionState === "reprocessing") {
    return "reprocessing";
  }
  if (episode.voiceSessionReceiptId) {
    return "voice_evidence_collected";
  }
  if (episode.portalInvestigationReceiptId) {
    return "portal_denied";
  }
  if (
    episode.adjudicationState === "accepted_for_processing" &&
    episode.remittanceState === "expected" &&
    episode.submissionReceiptId
  ) {
    return "accepted_overdue";
  }
  if (episode.submissionReceiptId) {
    return "claim_submitted";
  }
  if (episode.eligibilityReceiptId) {
    return "eligibility_checked";
  }
  // `heroStage` is a projection hint, not the source of truth. Durable
  // connector/action receipts above always win so a stale cached hint cannot
  // pin the UI to an earlier step after a successful action.
  if (episode.heroStage) {
    return episode.heroStage;
  }
  return "visit_ready";
}

export function getHeroStageView(episode: ClaimEpisode): HeroStageView | null {
  if (episode.fixtureKey !== "encounter-a") return null;
  const stage = deriveHeroStage(episode);
  return { stage, ...STAGE_META[stage] };
}

export function heroStageIndex(stage: HeroStage): number {
  return HERO_STAGES.indexOf(stage);
}

export function canAdvanceHeroStage(
  from: HeroStage,
  to: HeroStage,
): boolean {
  return heroStageIndex(to) === heroStageIndex(from) + 1 || to === from;
}
