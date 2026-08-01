import type { ClaimEpisode } from "@/domain/types";

export interface MossSeedDocument {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

function metadata(
  episode: ClaimEpisode,
  documentType: string,
  title: string,
  sourceReference: string,
): Record<string, string> {
  return {
    episodeId: episode.id,
    claimId: episode.claimId ?? episode.id,
    payerId: episode.payerId ?? "unknown-payer",
    fixtureKey: episode.fixtureKey,
    documentType,
    title,
    sourceReference,
    synthetic: "true",
  };
}

export interface BuildMossDocumentsOptions {
  /**
   * `v1` (default) preserves the original corpus shape exactly. `v2` adds
   * the guided hero claim's portal/voice/appeal-policy documents (gated on
   * the relevant durable receipt ids, never on names or member IDs) on top
   * of the v1 documents. Existing v1 callers and document counts are
   * unaffected by the v2 addition.
   */
  version?: "v1" | "v2";
}

function heroPortalPolicyDoc(episode: ClaimEpisode): MossSeedDocument | null {
  if (!episode.portalInvestigationReceiptId) return null;
  return {
    id: `portal-policy-${episode.id}`,
    text:
      `Payer portal investigation policy for synthetic claim ${episode.claimId}. ` +
      `The fictional Northstar payer portal is reached only through the approved browser ` +
      `automation connector; a screenshot and connector receipt are the durable evidence. ` +
      `Never infer a denial or its reason without a portal investigation receipt on file.`,
    metadata: metadata(
      episode,
      "policy:portal",
      "Portal investigation policy",
      `ConnectorReceipt/${episode.portalInvestigationReceiptId}`,
    ),
  };
}

function heroVoicePolicyDoc(episode: ClaimEpisode): MossSeedDocument | null {
  if (!episode.voiceSessionReceiptId) return null;
  return {
    id: `voice-policy-${episode.id}`,
    text:
      `Deepgram voice evidence policy for synthetic claim ${episode.claimId}. Voice evidence ` +
      `is collected only through a scripted, consented Deepgram session against a fictional ` +
      `payer phone tree; no real PSTN call is placed. The transcript, extracted facts, and ` +
      `connector receipt are the durable evidence once a voice session receipt is on file.`,
    metadata: metadata(
      episode,
      "policy:voice",
      "Voice evidence policy",
      `ConnectorReceipt/${episode.voiceSessionReceiptId}`,
    ),
  };
}

function heroAppealPolicyDoc(episode: ClaimEpisode): MossSeedDocument | null {
  if (episode.fixtureKey !== "encounter-a") return null;
  return {
    id: `appeal-policy-${episode.id}`,
    text:
      `Formal appeal policy for synthetic claim ${episode.claimId}. A formal appeal may only ` +
      `be proposed once a payer portal recheck confirms the denial was upheld. Submission ` +
      `requires explicit human Allow once approval and is executed through the approved ` +
      `browser automation connector against the fictional Northstar appeals portal. A ` +
      `confirmation number and follow-up date are the durable evidence once an appeal receipt ` +
      `is on file; never infer approval or confirmation without that receipt.`,
    metadata: metadata(
      episode,
      "policy:appeal",
      "Formal appeal policy",
      `Policy/overturn-appeal-${episode.fixtureKey}`,
    ),
  };
}

/**
 * Builds a synthetic-only retrieval corpus. Patient names and member IDs are
 * intentionally omitted even though the fixtures are synthetic; Moss only
 * needs claim-scoped operational evidence to ground this demo.
 */
export function buildMossDocuments(
  episodes: ClaimEpisode[],
  options?: BuildMossDocumentsOptions,
): MossSeedDocument[] {
  const version = options?.version ?? "v1";
  return episodes.flatMap((episode) => {
    const evidenceDocs = episode.evidence.map((evidence) => ({
      id: `evidence-${episode.id}-${evidence.id}`,
      text:
        `Synthetic claim ${episode.claimId}, date of service ${episode.dateOfService}, CPT ${episode.cpt}. ` +
        `${evidence.title}. ${evidence.summary}. Source reference ${evidence.reference}.`,
      metadata: metadata(
        episode,
        `evidence:${evidence.kind}`,
        evidence.title,
        evidence.reference,
      ),
    }));

    const observationDocs = episode.observations.map((observation) => ({
      id: `observation-${episode.id}-${observation.id}`,
      text:
        `Synthetic claim ${episode.claimId}. ${observation.source} reported raw status ` +
        `"${observation.rawStatus}", normalized as "${observation.normalizedStatus}", observed ` +
        `${observation.observedAt}. Source reference ${observation.evidenceReference}.`,
      metadata: metadata(
        episode,
        `observation:${observation.source}`,
        `${observation.source} status: ${observation.normalizedStatus}`,
        observation.evidenceReference,
      ),
    }));

    const discrepancyDocs = episode.discrepancies.map((discrepancy, index) => ({
      id: `discrepancy-${episode.id}-${discrepancy.ruleId}-${index}`,
      text:
        `Synthetic claim ${episode.claimId}. Reconciliation rule ${discrepancy.ruleId} found: ` +
        `${discrepancy.summary}. Compare the independent source timestamps before taking action.`,
      metadata: metadata(
        episode,
        "reconciliation-finding",
        `Reconciliation: ${discrepancy.ruleId}`,
        discrepancy.evidenceReferences[0] ?? `Claim/${episode.claimId}`,
      ),
    }));

    const workflowDoc: MossSeedDocument = {
      id: `workflow-${episode.id}`,
      text:
        `Workflow policy for synthetic claim ${episode.claimId}. Read-only status and evidence retrieval may run ` +
        `without approval. Any external healthcare write must first create a claim-scoped proposal, show the ` +
        `evidence and artifact preview, and receive explicit Allow once approval. Never infer paid status from ` +
        `submission, acceptance, a reprocessing request, or a single source. Current recommended action: ` +
        `${episode.agentAction ?? "no write action"}.`,
      metadata: metadata(
        episode,
        "workflow-policy",
        "Human approval and reconciliation policy",
        `Policy/overturn-${episode.fixtureKey}`,
      ),
    };

    const v1Docs = [...evidenceDocs, ...observationDocs, ...discrepancyDocs, workflowDoc];
    if (version === "v1") return v1Docs;

    const heroDocs = [
      heroPortalPolicyDoc(episode),
      heroVoicePolicyDoc(episode),
      heroAppealPolicyDoc(episode),
    ].filter((doc): doc is MossSeedDocument => doc !== null);

    return [...v1Docs, ...heroDocs];
  });
}

/** Convenience wrapper for `buildMossDocuments(episodes, { version: "v2" })`. */
export function buildMossDocumentsV2(episodes: ClaimEpisode[]): MossSeedDocument[] {
  return buildMossDocuments(episodes, { version: "v2" });
}
