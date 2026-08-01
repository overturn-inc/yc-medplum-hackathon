import { buildApprovalFingerprint, digestPayload } from "./approval";
import { getDemoClock } from "./clock";
import { evaluateDiscrepancies } from "./discrepancy";
import type { AgentProposal, ClaimEpisode } from "./types";

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
