import { buildApprovalFingerprint, digestPayload } from "./approval";
import type { ProposableActionType } from "./action-types";
import { getDemoClock } from "./clock";
import { evaluateDiscrepancies } from "./discrepancy";
import type { AgentProposal, ClaimEpisode } from "./types";

/**
 * ActionTypes with a deterministic local proposal builder
 * (submit_appeal / post_payment have none yet).
 *
 * `refresh_payer_status` is deliberately NOT here: claim-b's payer status
 * refresh is a dedicated read-only, non-approval action executed directly
 * via `ActionService.refreshPayerStatus`, never through a proposal/Allow
 * once flow (see `src/domain/action-policy.ts`).
 */
export type { ProposableActionType } from "./action-types";
export { defaultActionTypeForFixture } from "./action-types";

/**
 * Deterministic synthetic member-id correction used by claim-d's
 * correct_and_resubmit: the clearinghouse rejection is caused by a stale
 * member id on file, and the correction replaces it with a new one.
 * Exported so the proposal (predicted diff) and the execution (applied diff)
 * always agree on the exact same old -> new pair.
 */
export function deriveCorrectedMemberId(oldMemberId: string): string {
  const match = /^MEM-OLD-(.+)$/.exec(oldMemberId);
  if (match) return `MEM-NEW-${match[1]}`;
  return `${oldMemberId}-CORRECTED`;
}

export function buildSubmitProposal(episode: ClaimEpisode): AgentProposal {
  const payload = {
    action: "submit_claim",
    episodeId: episode.id,
    patientId: episode.patientId,
    payerId: episode.payerId,
    serviceLines: episode.serviceLines.map((s) => ({
      cpt: s.cpt,
      units: s.units,
      charge: s.charge,
    })),
    diagnoses: episode.diagnoses,
    billedAmount: episode.billedAmount,
    revision: episode.revision,
  };

  const payloadDigest = digestPayload(payload);
  return {
    id: `proposal-submit-${episode.id}`,
    episodeId: episode.id,
    actionType: "submit_claim",
    title: "Submit claim to clearinghouse",
    whatIFound:
      "Encounter is complete with final note, active coverage, diagnosis, and ready charges.",
    evidenceUsed: episode.evidence.map((e) => e.reference),
    proposedAction: "Create Claim and submit synthetically to clearinghouse.",
    artifactPreview: JSON.stringify(payload, null, 2),
    payloadDigest,
    episodeRevision: episode.revision,
    fingerprint: buildApprovalFingerprint({
      actionType: "submit_claim",
      episodeId: episode.id,
      payloadDigest,
      episodeRevision: episode.revision,
    }),
    createdAt: getDemoClock(),
  };
}

export function buildReprocessingProposal(episode: ClaimEpisode): AgentProposal {
  const discrepancies = evaluateDiscrepancies(episode);
  const conflict = discrepancies.find((d) => d.ruleId === "status_conflict");
  const authEvidence = episode.evidence.find((e) => e.kind === "authorization");

  const message = [
    `Subject: Request reprocessing for claim ${episode.claimId ?? episode.id}`,
    "",
    `Patient: ${episode.patientName}`,
    `Date of service: ${episode.dateOfService}`,
    `Payer claim reference: ${episode.claimControlNumber ?? episode.claimId}`,
    "",
    "We received an authorization-required denial that conflicts with on-file authorization evidence.",
    authEvidence
      ? `Authorization evidence: ${authEvidence.reference} - ${authEvidence.summary}`
      : "Authorization evidence is linked on the claim episode.",
    "",
    conflict
      ? `Compared sources: PMS ${conflict.comparedSources[0]?.normalizedStatus} at ${conflict.comparedSources[0]?.observedAt}; payer ${conflict.comparedSources[1]?.normalizedStatus} at ${conflict.comparedSources[1]?.observedAt}.`
      : "Source discrepancy detected between PMS processing and payer denial.",
    "",
    "Please reprocess this claim under the existing authorization-not-required determination covering the service date.",
  ].join("\n");

  const payload = {
    action: "request_reprocessing",
    episodeId: episode.id,
    claimId: episode.claimId,
    authorizationReference: authEvidence?.reference ?? null,
    message,
    revision: episode.revision,
  };

  const payloadDigest = digestPayload(payload);
  return {
    id: `proposal-reprocess-${episode.id}`,
    episodeId: episode.id,
    actionType: "request_reprocessing",
    title: "Request payer reprocessing",
    whatIFound:
      conflict?.summary ??
      "PMS processing conflicts with payer authorization denial.",
    evidenceUsed: [
      ...(conflict?.evidenceReferences ?? []),
      ...(authEvidence ? [authEvidence.reference] : []),
    ],
    proposedAction: "Send payer reprocessing request citing authorization evidence.",
    artifactPreview: message,
    payloadDigest,
    episodeRevision: episode.revision,
    fingerprint: buildApprovalFingerprint({
      actionType: "request_reprocessing",
      episodeId: episode.id,
      payloadDigest,
      episodeRevision: episode.revision,
    }),
    createdAt: getDemoClock(),
  };
}

/**
 * Claim rejected by the clearinghouse before adjudication: propose
 * correcting the identified data issue and resubmitting a corrected claim.
 */
export function buildCorrectAndResubmitProposal(episode: ClaimEpisode): AgentProposal {
  const rejection = episode.evidence.find((e) => e.kind === "raw_277");
  const oldMemberId = episode.memberId ?? `MEM-OLD-${episode.id}`;
  const newMemberId = deriveCorrectedMemberId(oldMemberId);

  const payload = {
    action: "correct_and_resubmit",
    episodeId: episode.id,
    originalClaimId: episode.claimId,
    rejectionReference: rejection?.reference ?? null,
    issue: episode.issue,
    revision: episode.revision,
    memberIdCorrection: { oldMemberId, newMemberId },
  };

  const payloadDigest = digestPayload(payload);
  return {
    id: `proposal-correct-resubmit-${episode.id}`,
    episodeId: episode.id,
    actionType: "correct_and_resubmit",
    title: "Correct and resubmit claim",
    whatIFound:
      `${rejection?.summary ?? episode.issue ?? "Clearinghouse rejected the claim before adjudication."} ` +
      `The member id on file is stale: ${oldMemberId} -> ${newMemberId}.`,
    evidenceUsed: [
      ...new Set([
        ...(rejection ? [rejection.reference] : []),
        ...episode.evidence.map((e) => e.reference),
      ]),
    ],
    proposedAction:
      `Correct the member id (${oldMemberId} -> ${newMemberId}) and resubmit a corrected claim to the clearinghouse.`,
    artifactPreview: JSON.stringify(payload, null, 2),
    memberIdCorrection: { oldMemberId, newMemberId },
    payloadDigest,
    episodeRevision: episode.revision,
    fingerprint: buildApprovalFingerprint({
      actionType: "correct_and_resubmit",
      episodeId: episode.id,
      payloadDigest,
      episodeRevision: episode.revision,
    }),
    createdAt: getDemoClock(),
  };
}

/**
 * Claim pended by the payer requesting supporting documentation: propose
 * sending the requested documentation packet.
 */
export function buildSendDocumentationProposal(episode: ClaimEpisode): AgentProposal {
  const pendNotice = episode.evidence.find((e) => e.kind === "portal_snapshot");
  const supportingNote = episode.evidence.find((e) => e.kind === "note");

  const payload = {
    action: "send_documentation",
    episodeId: episode.id,
    claimId: episode.claimId,
    pendNoticeReference: pendNotice?.reference ?? null,
    packetReferences: [supportingNote?.reference].filter(
      (ref): ref is string => !!ref,
    ),
    revision: episode.revision,
  };

  const payloadDigest = digestPayload(payload);
  return {
    id: `proposal-send-documentation-${episode.id}`,
    episodeId: episode.id,
    actionType: "send_documentation",
    title: "Send requested documentation",
    whatIFound:
      pendNotice?.summary ??
      episode.issue ??
      "Payer pended the claim requesting supporting documentation.",
    evidenceUsed: [
      ...new Set([
        ...(pendNotice ? [pendNotice.reference] : []),
        ...(supportingNote ? [supportingNote.reference] : []),
        ...episode.evidence.map((e) => e.reference),
      ]),
    ],
    proposedAction:
      "Send the requested supporting documentation packet to the payer.",
    artifactPreview: JSON.stringify(payload, null, 2),
    payloadDigest,
    episodeRevision: episode.revision,
    fingerprint: buildApprovalFingerprint({
      actionType: "send_documentation",
      episodeId: episode.id,
      payloadDigest,
      episodeRevision: episode.revision,
    }),
    createdAt: getDemoClock(),
  };
}

/** Deterministic builder dispatch for every action type with a local proposal. */
export const PROPOSAL_BUILDERS: Record<
  ProposableActionType,
  (episode: ClaimEpisode) => AgentProposal
> = {
  submit_claim: buildSubmitProposal,
  request_reprocessing: buildReprocessingProposal,
  correct_and_resubmit: buildCorrectAndResubmitProposal,
  send_documentation: buildSendDocumentationProposal,
};

/**
 * The action a fresh proposal should default to for a given episode's fixture
 * when the caller (agent chat "do it" / re-propose) does not specify one
 * explicitly. claim-f has no scripted mutation and returns null.
 */
export function buildProposalForAction(
  actionType: ProposableActionType,
  episode: ClaimEpisode,
): AgentProposal {
  return PROPOSAL_BUILDERS[actionType](episode);
}
