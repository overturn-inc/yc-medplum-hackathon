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

/**
 * Builds a synthetic-only retrieval corpus. Patient names and member IDs are
 * intentionally omitted even though the fixtures are synthetic; Moss only
 * needs claim-scoped operational evidence to ground this demo.
 */
export function buildMossDocuments(episodes: ClaimEpisode[]): MossSeedDocument[] {
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

    return [...evidenceDocs, ...observationDocs, ...discrepancyDocs, workflowDoc];
  });
}
