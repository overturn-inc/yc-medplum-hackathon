import {
  assertClientApprovalScope,
  assertFreshApproval,
  buildApprovalFingerprint,
  createApprovalReceipt,
  proposalApprovalFields,
  type ClientApprovalScope,
} from "@/domain/approval";
import { getDemoClock, addDays } from "@/domain/clock";
import {
  buildReprocessingAuditEvent,
  buildReprocessingProvenance,
  buildSubmissionAuditEvent,
} from "@/domain/fhir-audit";
import { runPreflight, preflightReady } from "@/domain/preflight";
import { buildReprocessingProposal, buildSubmitProposal } from "@/domain/proposals";
import type {
  ActivityEvent,
  ClaimEpisode,
  DomainEvent,
  ExecutionReceipt,
  SourceObservation,
} from "@/domain/types";
import type { LocalEventStore } from "./store";
import type { AgentAdapter } from "@/adapters/agent/types";
import { createSyntheticAgentAdapter } from "@/adapters/agent/synthetic";

function activity(
  episodeId: string,
  kind: string,
  summary: string,
  at = getDemoClock(),
): ActivityEvent {
  return {
    id: `activity-${episodeId}-${kind}-${at}-${Math.random().toString(36).slice(2, 7)}`,
    episodeId,
    at,
    kind,
    summary,
    synthetic: true,
  };
}

function pushObservation(episode: ClaimEpisode, observation: SourceObservation): void {
  episode.observations = [...episode.observations, observation];
}

function scopesMatch(
  persisted: {
    proposalId: string;
    episodeId: string;
    actionType: string;
    payloadDigest: string;
    episodeRevision: number;
    fingerprint: string;
  },
  client: ClientApprovalScope,
): boolean {
  return (
    persisted.proposalId === client.proposalId &&
    persisted.episodeId === client.episodeId &&
    persisted.actionType === client.actionType &&
    persisted.payloadDigest === client.payloadDigest &&
    persisted.episodeRevision === client.episodeRevision &&
    persisted.fingerprint === client.fingerprint
  );
}

export class ActionService {
  constructor(
    private readonly store: LocalEventStore,
    private readonly agent: AgentAdapter = createSyntheticAgentAdapter(),
  ) {}

  createProposal(episodeId: string, action: "submit_claim" | "request_reprocessing") {
    this.store.beginMutation();
    try {
      const snapshot = this.store.getSnapshot();
      if (snapshot.agentMode === "bff") {
        throw Object.assign(
          new Error(
            "BFF mode does not expose deterministic local proposals. Agent boundary is unavailable or not probed.",
          ),
          { status: 503, code: "BFF_PROPOSAL_BLOCKED" },
        );
      }
      const episode = this.store.getEpisode(episodeId);
      if (!episode) throw Object.assign(new Error("Episode not found"), { status: 404 });

      const bumped = {
        ...episode,
        revision: episode.revision + 1,
      };
      const proposal =
        action === "submit_claim"
          ? buildSubmitProposal(bumped)
          : buildReprocessingProposal(bumped);

      const next = {
        ...bumped,
        proposal,
        resolutionState: "approval_required" as const,
      };
      next.activities = [
        ...episode.activities,
        activity(episodeId, "proposal.created", `Proposal created: ${proposal.title}`),
      ];
      const event: DomainEvent = {
        type: "proposal.created",
        id: `event-proposal-${proposal.id}`,
        at: getDemoClock(),
        episodeId,
        proposalId: proposal.id,
      };
      this.store.replaceEpisode(next);
      this.store.appendEvent(event);
      const committed = this.store.commit();
      return {
        snapshot: committed,
        proposal,
        approvalScope: proposalApprovalFields(proposal),
      };
    } catch (error) {
      this.store.abortMutation();
      throw error;
    }
  }

  async decide(input: {
    episodeId: string;
    decision: "allow_once" | "deny";
    actionType: "submit_claim" | "request_reprocessing";
    scope?: ClientApprovalScope;
  }) {
    this.store.beginMutation();
    try {
      const episode = this.store.getEpisode(input.episodeId);
      if (!episode) throw Object.assign(new Error("Episode not found"), { status: 404 });

      if (!input.scope) {
        throw Object.assign(
          new Error(
            "Approval scope required: proposalId, payloadDigest, episodeRevision, fingerprint",
          ),
          { status: 409 },
        );
      }

      const prior = this.store.findApprovalConsumed({
        episodeId: input.episodeId,
        actionType: input.actionType,
      });

      if (input.decision === "allow_once" && prior) {
        if (!scopesMatch(prior, input.scope)) {
          throw Object.assign(
            new Error(
              "Stale or tampered approval scope: does not match the consumed approval ledger",
            ),
            { status: 409 },
          );
        }
        const snapshot = this.store.getSnapshot();
        this.store.abortMutation();
        return {
          snapshot,
          receiptId: prior.receiptId,
          idempotent: true,
          approvalScope: {
            proposalId: prior.proposalId,
            episodeId: prior.episodeId,
            actionType: prior.actionType as ClientApprovalScope["actionType"],
            payloadDigest: prior.payloadDigest,
            episodeRevision: prior.episodeRevision,
            fingerprint: prior.fingerprint,
          },
        };
      }

      if (!episode.proposal || episode.proposal.actionType !== input.actionType) {
        throw Object.assign(new Error("No matching proposal"), { status: 409 });
      }

      assertClientApprovalScope({
        proposal: episode.proposal,
        currentRevision: episode.revision,
        client: input.scope,
      });

      const receipt = createApprovalReceipt({
        proposal: episode.proposal,
        decision: input.decision,
        decidedAt: getDemoClock(),
      });

      const expectedFingerprint = buildApprovalFingerprint({
        actionType: episode.proposal.actionType,
        episodeId: episode.proposal.episodeId,
        payloadDigest: episode.proposal.payloadDigest,
        episodeRevision: episode.revision,
      });

      assertFreshApproval({
        receipt,
        currentRevision: episode.revision,
        expectedFingerprint,
      });

      if (input.decision === "deny") {
        return this.deny(episode, receipt.id, input.scope);
      }

      const existing = this.store.getExecutionReceipt(receipt.idempotencyKey);
      if (existing && prior && scopesMatch(prior, input.scope)) {
        const snapshot = this.store.getSnapshot();
        this.store.abortMutation();
        return {
          snapshot,
          receiptId: existing,
          idempotent: true,
          approvalScope: proposalApprovalFields(episode.proposal),
        };
      }

      if (input.actionType === "submit_claim") {
        return await this.executeSubmit(
          episode,
          receipt.id,
          receipt.idempotencyKey,
          input.scope,
        );
      }
      return await this.executeReprocessing(
        episode,
        receipt.id,
        receipt.idempotencyKey,
        input.scope,
      );
    } catch (error) {
      this.store.abortMutation();
      throw error;
    }
  }

  private deny(
    episode: ClaimEpisode,
    approvalId: string,
    scope: ClientApprovalScope,
  ) {
    const proposal = episode.proposal!;
    const next: ClaimEpisode = {
      ...episode,
      proposal: null,
      resolutionState: "investigating",
      agentAction: null,
      issue: `Denied: ${proposal.title}. Create a new proposal to reconsider.`,
      activities: [
        ...episode.activities,
        activity(episode.id, "proposal.denied", `Denied proposal ${proposal.title}`),
      ],
    };
    const event: DomainEvent = {
      type: "proposal.denied",
      id: `event-deny-${approvalId}`,
      at: getDemoClock(),
      episodeId: episode.id,
      proposalId: proposal.id,
      actionType: proposal.actionType,
    };
    this.store.replaceEpisode(next);
    this.store.appendEvent(event);
    return {
      snapshot: this.store.commit(),
      receiptId: null,
      denied: true,
      approvalScope: scope,
    };
  }

  private async executeSubmit(
    episode: ClaimEpisode,
    approvalId: string,
    idempotencyKey: string,
    scope: ClientApprovalScope,
  ) {
    const checks = runPreflight(episode);
    if (!preflightReady(checks)) {
      throw Object.assign(new Error("Preflight failed"), { status: 400, checks });
    }

    const agentResult = await this.agent.executeApprovedAction({
      actionType: "submit_claim",
      episodeId: episode.id,
      idempotencyKey,
      payloadDigest: episode.proposal!.payloadDigest,
    });

    if (agentResult.outcome === "failed") {
      throw Object.assign(new Error(agentResult.message), { status: 502 });
    }

    if (agentResult.outcome === "pending_verification") {
      return this.markPendingVerification(
        episode,
        "submit_claim",
        idempotencyKey,
        agentResult.message,
      );
    }

    const at = getDemoClock();
    const claimId = `CLM-EA-${episode.id.slice(-4).toUpperCase()}`;
    const receiptId = `receipt-submit-${episode.id}`;
    const execution: ExecutionReceipt = {
      id: receiptId,
      approvalId,
      episodeId: episode.id,
      actionType: "submit_claim",
      idempotencyKey,
      outcome: "success",
      message: "Synthetic clearinghouse accepted transmission",
      executedAt: at,
      evidenceReference: `ClaimResponse/${receiptId}`,
    };

    const audit = buildSubmissionAuditEvent({
      episodeId: episode.id,
      claimId,
      receiptId,
      at,
    });

    const next: ClaimEpisode = {
      ...episode,
      claimId,
      chargeState: "claim_created",
      transportState: "sent",
      adjudicationState: "accepted_for_processing",
      resolutionState: "monitoring",
      issue: "Submitted; awaiting payer",
      agentAction: null,
      proposal: null,
      submissionReceiptId: receiptId,
      claimControlNumber: `CN-EA-${episode.id.slice(-4).toUpperCase()}`,
      revision: episode.revision + 1,
      lastVerifiedAt: at,
      fhirResources: [
        ...(episode.fhirResources ?? []),
        audit as unknown as Record<string, unknown>,
      ],
      evidence: [
        ...episode.evidence,
        {
          id: `ev-${receiptId}`,
          title: "Submission receipt",
          kind: "receipt",
          reference: execution.evidenceReference,
          summary: execution.message,
          synthetic: true,
          observedAt: at,
        },
      ],
      activities: [
        ...episode.activities,
        activity(episode.id, "approval.consumed", "Allow once consumed for claim submit", at),
        activity(episode.id, "claim.submitted", `Claim ${claimId} submitted`, at),
        activity(episode.id, "audit.created", `AuditEvent/${audit.id}`, at),
      ],
    };

    pushObservation(next, {
      id: `obs-${episode.id}-transport-submit`,
      episodeId: episode.id,
      source: "clearinghouse",
      rawStatus: "Accepted for processing",
      normalizedStatus: "accepted_for_processing",
      observedAt: at,
      lastVerifiedAt: at,
      evidenceReference: execution.evidenceReference,
      synthetic: true,
    });
    pushObservation(next, {
      id: `obs-${episode.id}-pms-submit`,
      episodeId: episode.id,
      source: "pms",
      rawStatus: "Submitted",
      normalizedStatus: "accepted_for_processing",
      observedAt: at,
      lastVerifiedAt: at,
      evidenceReference: `Claim/${claimId.toLowerCase()}`,
      synthetic: true,
    });

    const events: DomainEvent[] = [
      {
        type: "approval.consumed",
        id: `event-approval-${approvalId}`,
        at,
        episodeId: episode.id,
        approvalId,
        actionType: "submit_claim",
        idempotencyKey,
        proposalId: scope.proposalId,
        payloadDigest: scope.payloadDigest,
        episodeRevision: scope.episodeRevision,
        fingerprint: scope.fingerprint,
        receiptId,
      },
      {
        type: "claim.submitted",
        id: `event-submit-${receiptId}`,
        at,
        episodeId: episode.id,
        claimId,
        receiptId,
        idempotencyKey,
      },
      {
        type: "audit.created",
        id: `event-audit-submit-${receiptId}`,
        at,
        episodeId: episode.id,
        auditId: `AuditEvent/${audit.id}`,
      },
    ];

    this.store.replaceEpisode(next);
    for (const event of events) this.store.appendEvent(event);
    this.store.rememberExecution(idempotencyKey, receiptId);
    return { snapshot: this.store.commit(), receiptId, execution, idempotent: false };
  }

  private async executeReprocessing(
    episode: ClaimEpisode,
    approvalId: string,
    idempotencyKey: string,
    scope: ClientApprovalScope,
  ) {
    const agentResult = await this.agent.executeApprovedAction({
      actionType: "request_reprocessing",
      episodeId: episode.id,
      idempotencyKey,
      payloadDigest: episode.proposal!.payloadDigest,
    });

    if (agentResult.outcome === "failed") {
      throw Object.assign(new Error(agentResult.message), { status: 502 });
    }

    if (agentResult.outcome === "pending_verification") {
      return this.markPendingVerification(
        episode,
        "request_reprocessing",
        idempotencyKey,
        agentResult.message,
      );
    }

    const at = getDemoClock();
    const receiptId = `receipt-reprocess-${episode.id}`;
    const artifactId = `DocumentReference/artifact-reprocess-${episode.id}`;
    const followUpAt = addDays(at, 7);
    const claimId = episode.claimId ?? `CLM-${episode.id}`;
    const provenance = buildReprocessingProvenance({
      episodeId: episode.id,
      claimId,
      artifactId,
      receiptId,
      at,
    });
    const audit = buildReprocessingAuditEvent({
      episodeId: episode.id,
      claimId,
      artifactId,
      receiptId,
      at,
    });
    const provenanceId = `Provenance/${provenance.id}`;
    const auditId = `AuditEvent/${audit.id}`;
    const message = episode.proposal?.artifactPreview ?? "";

    const next: ClaimEpisode = {
      ...episode,
      resolutionState: "reprocessing",
      adjudicationState: "denied",
      issue: "Reprocessing requested; waiting on payer",
      agentAction: "Monitor reprocessing",
      proposal: null,
      reprocessingReceiptId: receiptId,
      nextFollowUpAt: followUpAt,
      revision: episode.revision + 1,
      lastVerifiedAt: at,
      fhirResources: [
        ...(episode.fhirResources ?? []),
        provenance as unknown as Record<string, unknown>,
        audit as unknown as Record<string, unknown>,
      ],
      evidence: [
        ...episode.evidence,
        {
          id: `ev-artifact-${episode.id}`,
          title: "Payer reprocessing message",
          kind: "artifact",
          reference: artifactId,
          summary: message.slice(0, 180),
          synthetic: true,
          observedAt: at,
        },
        {
          id: `ev-receipt-${receiptId}`,
          title: "Reprocessing execution receipt",
          kind: "receipt",
          reference: `ClaimResponse/${receiptId}`,
          summary: "Synthetic payer connector accepted reprocessing request",
          synthetic: true,
          observedAt: at,
        },
      ],
      activities: [
        ...episode.activities,
        activity(episode.id, "approval.consumed", "Allow once consumed for reprocessing", at),
        activity(episode.id, "artifact.created", `Created ${artifactId}`, at),
        activity(episode.id, "reprocessing.requested", "Synthetic reprocessing submitted", at),
        activity(episode.id, "followup.scheduled", `Next follow-up ${followUpAt}`, at),
        activity(episode.id, "provenance.created", `Created ${provenanceId}`, at),
        activity(episode.id, "audit.created", `Created ${auditId}`, at),
      ],
    };

    const events: DomainEvent[] = [
      {
        type: "approval.consumed",
        id: `event-approval-${approvalId}`,
        at,
        episodeId: episode.id,
        approvalId,
        actionType: "request_reprocessing",
        idempotencyKey,
        proposalId: scope.proposalId,
        payloadDigest: scope.payloadDigest,
        episodeRevision: scope.episodeRevision,
        fingerprint: scope.fingerprint,
        receiptId,
      },
      {
        type: "artifact.created",
        id: `event-artifact-${episode.id}`,
        at,
        episodeId: episode.id,
        artifactId,
      },
      {
        type: "reprocessing.requested",
        id: `event-reprocess-${receiptId}`,
        at,
        episodeId: episode.id,
        artifactId,
        receiptId,
        followUpAt,
        idempotencyKey,
      },
      {
        type: "provenance.created",
        id: `event-prov-${episode.id}`,
        at,
        episodeId: episode.id,
        provenanceId,
      },
      {
        type: "audit.created",
        id: `event-audit-reprocess-${episode.id}`,
        at,
        episodeId: episode.id,
        auditId,
      },
    ];

    this.store.replaceEpisode(next);
    for (const event of events) this.store.appendEvent(event);
    this.store.rememberExecution(idempotencyKey, receiptId);
    return {
      snapshot: this.store.commit(),
      receiptId,
      artifactId,
      followUpAt,
      provenanceId,
      auditId,
      idempotent: false,
    };
  }

  private markPendingVerification(
    episode: ClaimEpisode,
    actionType: "submit_claim" | "request_reprocessing",
    idempotencyKey: string,
    message: string,
  ) {
    const at = getDemoClock();
    const next: ClaimEpisode = {
      ...episode,
      // Keep proposal for safe retry after verification; no success mutation.
      resolutionState: "approval_required",
      issue: `Pending verification: ${message}`,
      agentAction: "Retry after verification",
      activities: [
        ...episode.activities,
        activity(
          episode.id,
          "execution.pending_verification",
          `Pending verification for ${actionType}: ${message}`,
          at,
        ),
      ],
    };
    const event: DomainEvent = {
      type: "execution.pending_verification",
      id: `event-pending-${episode.id}-${at}`,
      at,
      episodeId: episode.id,
      actionType,
      idempotencyKey,
      message,
    };
    this.store.replaceEpisode(next);
    this.store.appendEvent(event);
    return {
      snapshot: this.store.commit(),
      receiptId: null,
      pendingVerification: true,
      message,
      idempotent: false,
    };
  }
}
