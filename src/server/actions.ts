import {
  assertClientApprovalScope,
  assertFreshApproval,
  buildApprovalFingerprint,
  createApprovalReceipt,
  digestPayload,
  proposalApprovalFields,
  type ClientApprovalScope,
} from "@/domain/approval";
import { assertActionAllowed } from "@/domain/action-policy";
import { getDemoClock, addDays } from "@/domain/clock";
import { deriveHeroStage } from "@/domain/hero";
import {
  buildAppealAuditEvent,
  buildAppealProvenance,
  buildReprocessingAuditEvent,
  buildReprocessingProvenance,
  buildSubmissionAuditEvent,
} from "@/domain/fhir-audit";
import { runPreflight, preflightReady } from "@/domain/preflight";
import { runApprovalGatedToolJob } from "@/server/tool-jobs";
import { buildClaimResource } from "@/domain/fixtures";
import {
  buildProposalForAction,
  defaultActionTypeForFixture,
  deriveCorrectedMemberId,
  type ProposableActionType,
} from "@/domain/proposals";
import type {
  ActionType,
  ActivityEvent,
  ClaimEpisode,
  DomainEvent,
  EligibilitySummary,
  ExecutionReceipt,
  SourceObservation,
} from "@/domain/types";
import type { SessionRepository } from "@/server/repository";
import type { AgentAdapter } from "@/adapters/agent/types";
import { createSyntheticAgentAdapter } from "@/adapters/agent/synthetic";

export type { ProposableActionType } from "@/domain/proposals";

/** Normalized Stedi 270/271 fields the eligibility route may persist; never raw X12. */
export interface EligibilityCheckInput {
  checkId: string;
  applicationMode: string;
  activeCoverage: boolean;
  activeBenefitCount: number;
  planNames: string[];
  hasRaw271: boolean;
}

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
    private readonly store: SessionRepository,
    private readonly agent: AgentAdapter = createSyntheticAgentAdapter(),
  ) {}

  /**
   * Creates (or re-creates, e.g. after a deny) a deterministic local
   * proposal. `action` is optional: when omitted, the fixture's scripted
   * default action is used (submit_claim for encounter-a, request_reprocessing
   * for claim-c, correct_and_resubmit for claim-d, send_documentation for
   * claim-e). Fixtures without a scripted proposal action (claim-a, claim-b,
   * claim-f) require an explicit `action`; claim-b's `assertActionAllowed`
   * additionally rejects every proposal-shaped action outright, since its
   * only scripted action is the read-only `refreshPayerStatus` (see below).
   */
  async createProposal(episodeId: string, action?: ProposableActionType) {
    return this.store.withMutationLock(() =>
      this.createProposalUnlocked(episodeId, action),
    );
  }

  private async createProposalUnlocked(
    episodeId: string,
    action?: ProposableActionType,
  ) {
    await this.store.beginMutation();
    try {
      const snapshot = await this.store.getSnapshot();
      // Block deterministic proposals only when the ActionService execution
      // adapter itself is the BFF connector. Local+BFF demos keep an
      // independent synthetic executor so server-built proposals still work.
      if (snapshot.agentMode === "bff" && this.agent.mode === "bff") {
        throw Object.assign(
          new Error(
            "BFF mode does not expose deterministic local proposals. Agent boundary is unavailable or not probed.",
          ),
          { status: 503, code: "BFF_PROPOSAL_BLOCKED" },
        );
      }
      const episode = await this.store.getEpisode(episodeId);
      if (!episode) throw Object.assign(new Error("Episode not found"), { status: 404 });

      const resolvedAction = action ?? defaultActionTypeForFixture(episode.fixtureKey, episode);
      if (!resolvedAction) {
        throw Object.assign(
          new Error(
            `No default proposal action for ${episode.fixtureKey}; specify an actionType`,
          ),
          { status: 400 },
        );
      }
      assertActionAllowed(episode, resolvedAction);

      const bumped = {
        ...episode,
        revision: episode.revision + 1,
      };
      const proposal = buildProposalForAction(resolvedAction, bumped);

      // Encounter-a's submit_appeal proposal is the trigger for the
      // appeal_ready hero stage (see `deriveHeroStage`): the guided flow's
      // `prepare_appeal` hero action only creates this proposal, so the
      // stage must be advanced explicitly here rather than left at
      // whatever `heroStage` a prior tool job (e.g. denial_upheld) set.
      const fromStage =
        episode.fixtureKey === "encounter-a" ? deriveHeroStage(episode) : null;
      const advancesHeroStage =
        fromStage !== null && resolvedAction === "submit_appeal" && fromStage !== "appeal_ready";

      const next = {
        ...bumped,
        proposal,
        resolutionState: "approval_required" as const,
        agentAction: proposal.title,
        ...(advancesHeroStage ? { heroStage: "appeal_ready" as const } : {}),
      };
      next.activities = [
        ...episode.activities,
        activity(episodeId, "proposal.created", `Proposal created: ${proposal.title}`),
      ];
      const events: DomainEvent[] = [
        {
          type: "proposal.created",
          id: `event-proposal-${proposal.id}-${Math.random().toString(36).slice(2, 7)}`,
          at: getDemoClock(),
          episodeId,
          proposalId: proposal.id,
        },
      ];
      if (advancesHeroStage) {
        events.push({
          type: "hero.stage.advanced",
          id: `event-hero-appeal-ready-${proposal.id}`,
          at: getDemoClock(),
          episodeId,
          fromStage: fromStage!,
          toStage: "appeal_ready",
        });
      }
      this.store.replaceEpisode(next);
      for (const event of events) this.store.appendEvent(event);
      const committed = await this.store.commit();
      return {
        snapshot: committed,
        proposal,
        approvalScope: proposalApprovalFields(proposal),
      };
    } catch (error) {
      await this.store.abortMutation();
      throw error;
    }
  }

  async decide(input: {
    episodeId: string;
    decision: "allow_once" | "deny";
    actionType: ProposableActionType;
    scope?: ClientApprovalScope;
  }) {
    return this.store.withMutationLock(() => this.decideUnlocked(input));
  }

  private async decideUnlocked(input: {
    episodeId: string;
    decision: "allow_once" | "deny";
    actionType: ProposableActionType;
    scope?: ClientApprovalScope;
  }) {
    await this.store.beginMutation();
    try {
      const episode = await this.store.getEpisode(input.episodeId);
      if (!episode) throw Object.assign(new Error("Episode not found"), { status: 404 });

      if (!input.scope) {
        throw Object.assign(
          new Error(
            "Approval scope required: proposalId, payloadDigest, episodeRevision, fingerprint",
          ),
          { status: 409 },
        );
      }

      const prior = await this.store.findApprovalConsumed({
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
        const snapshot = await this.store.getSnapshot();
        await this.store.abortMutation();
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

      // Server-owned policy: never trust the caller-supplied actionType alone.
      // Idempotent retries of an already-committed approval short-circuit above
      // before reaching this check, so this only guards genuinely new decisions.
      assertActionAllowed(episode, input.actionType);

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
        return await this.deny(episode, receipt.id, input.scope);
      }

      const existing = await this.store.getExecutionReceipt(receipt.idempotencyKey);
      if (existing && prior && scopesMatch(prior, input.scope)) {
        const snapshot = await this.store.getSnapshot();
        await this.store.abortMutation();
        return {
          snapshot,
          receiptId: existing,
          idempotent: true,
          approvalScope: proposalApprovalFields(episode.proposal),
        };
      }

      // Reserve the exact idempotency key BEFORE any connector execution.
      // `withMutationLock` already serializes callers on this repository
      // instance, but the reservation is a durable, repository-backed guard
      // (unique on session + key) that also protects a network-backed
      // (D1/SQL) repository shared across separate server processes, where
      // the in-process lock alone would not be sufficient.
      if (this.store.reserveAction) {
        const reservation = await this.store.reserveAction({
          clientRequestId: receipt.idempotencyKey,
          episodeId: episode.id,
          actionType: input.actionType,
        });
        if (!reservation.reserved) {
          if (reservation.existingReceiptId) {
            const snapshot = await this.store.getSnapshot();
            await this.store.abortMutation();
            return {
              snapshot,
              receiptId: reservation.existingReceiptId,
              idempotent: true,
              approvalScope: proposalApprovalFields(episode.proposal),
            };
          }
          if (input.actionType !== "submit_appeal") {
            const snapshot = await this.store.getSnapshot();
            await this.store.abortMutation();
            return {
              snapshot,
              receiptId: null,
              pendingVerification: true,
              message:
                "This action is already being executed for the exact same idempotency key; no second execution was started.",
              idempotent: false,
            };
          }
          // Appeal execution is receipt-first. A prior reservation without a
          // domain receipt means the same connector job must be polled and
          // reconciled below, never created a second time.
        }
      }

      switch (input.actionType) {
        case "submit_claim":
          return await this.executeSubmit(
            episode,
            receipt.id,
            receipt.idempotencyKey,
            input.scope,
          );
        case "request_reprocessing":
          return await this.executeReprocessing(
            episode,
            receipt.id,
            receipt.idempotencyKey,
            input.scope,
          );
        case "correct_and_resubmit":
          return await this.executeCorrectAndResubmit(
            episode,
            receipt.id,
            receipt.idempotencyKey,
            input.scope,
          );
        case "send_documentation":
          return await this.executeSendDocumentation(
            episode,
            receipt.id,
            receipt.idempotencyKey,
            input.scope,
          );
        case "submit_appeal":
          return await this.executeSubmitAppeal(
            episode,
            receipt.id,
            receipt.idempotencyKey,
            input.scope,
          );
        default: {
          const exhaustive: never = input.actionType;
          throw Object.assign(
            new Error(`Unsupported action type: ${exhaustive as string}`),
            { status: 400 },
          );
        }
      }
    } catch (error) {
      await this.store.abortMutation();
      throw error;
    }
  }

  private async deny(
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
      snapshot: await this.store.commit(),
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
    // Fixed synthetic claim id aligned with the Northstar portal allowlist.
    const claimId =
      episode.fixtureKey === "encounter-a"
        ? "CLM-EA-1001"
        : `CLM-EA-${episode.id.slice(-4).toUpperCase()}`;
    const receiptId = `receipt-submit-${episode.id}`;
    const execution: ExecutionReceipt = {
      id: receiptId,
      approvalId,
      episodeId: episode.id,
      actionType: "submit_claim",
      idempotencyKey,
      outcome: "success",
      message:
        "Simulated Stedi clearinghouse rail accepted transmission (not a live 837P)",
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
      transportState: "clearinghouse_received",
      adjudicationState: "not_found",
      resolutionState: "monitoring",
      issue: "Received by clearinghouse; awaiting payer acknowledgment",
      agentAction: null,
      proposal: null,
      submissionReceiptId: receiptId,
      ...(episode.fixtureKey === "encounter-a"
        ? { heroStage: "claim_submitted" as const }
        : {}),
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
      rawStatus: "Received by clearinghouse",
      normalizedStatus: "clearinghouse_received",
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
      normalizedStatus: "sent",
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
    await this.store.rememberExecution(idempotencyKey, receiptId);
    return {
      snapshot: await this.store.commit(),
      receiptId,
      execution,
      idempotent: false,
    };
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
    await this.store.rememberExecution(idempotencyKey, receiptId);
    return {
      snapshot: await this.store.commit(),
      receiptId,
      artifactId,
      followUpAt,
      provenanceId,
      auditId,
      idempotent: false,
    };
  }

  /**
   * Claim B: read-only payer status refresh. This is deliberately NOT a
   * proposal/approval-gated action -- claim-b never enters
   * approval_required and never carries a proposal (see
   * `assertActionAllowed` and `rehydrateEpisode`). It executes immediately
   * on request, appends a synthetic payer observation plus a fresh
   * follow-up date, and NEVER creates an `approval.consumed` event or marks
   * the claim paid. Idempotent per episode revision: a duplicate call
   * before the episode has changed returns the same receipt without a
   * second side effect.
   */
  async refreshPayerStatus(episodeId: string) {
    return this.store.withMutationLock(() =>
      this.refreshPayerStatusUnlocked(episodeId),
    );
  }

  private async refreshPayerStatusUnlocked(episodeId: string) {
    await this.store.beginMutation();
    try {
      const episode = await this.store.getEpisode(episodeId);
      if (!episode) throw Object.assign(new Error("Episode not found"), { status: 404 });
      if (episode.fixtureKey !== "claim-b") {
        throw Object.assign(
          new Error("Payer status refresh is only available for claim-b"),
          { status: 400 },
        );
      }

      const idempotencyKey = `refresh_payer_status:${episodeId}:${episode.revision}`;
      if (this.store.reserveAction) {
        const reservation = await this.store.reserveAction({
          clientRequestId: idempotencyKey,
          episodeId,
          actionType: "refresh_payer_status",
        });
        if (!reservation.reserved) {
          const snapshot = await this.store.getSnapshot();
          await this.store.abortMutation();
          return {
            snapshot,
            receiptId: reservation.existingReceiptId ?? episode.statusRefreshReceiptId ?? null,
            followUpAt: episode.nextFollowUpAt,
            idempotent: true,
            message: reservation.existingReceiptId
              ? "Payer status was already refreshed for this revision; returning the existing result."
              : "A payer status refresh is already in progress for this revision.",
          };
        }
      }

      const agentResult = await this.agent.executeApprovedAction({
        actionType: "refresh_payer_status",
        episodeId: episode.id,
        idempotencyKey,
        payloadDigest: digestPayload({
          episodeId,
          revision: episode.revision,
          adjudicationState: episode.adjudicationState,
        }),
      });

      if (agentResult.outcome === "failed") {
        throw Object.assign(new Error(agentResult.message), { status: 502 });
      }
      if (agentResult.outcome === "pending_verification") {
        return this.markPendingVerification(
          episode,
          "refresh_payer_status",
          idempotencyKey,
          agentResult.message,
        );
      }

      const at = getDemoClock();
      const receiptId = `receipt-status-refresh-${episode.id}-${at}`;
      const followUpAt = addDays(at, 7);
      const observationId = `obs-${episode.id}-payer-refresh-${at}`;
      const evidenceReference = `DocumentReference/doc-portal-refresh-${episode.id}-${at}`;

      let next: ClaimEpisode = {
        ...episode,
        // adjudicationState intentionally unchanged: a status refresh only
        // re-confirms the existing payer status, it never infers paid, and
        // it never touches resolutionState away from its non-approval state.
        issue: `Payer status re-confirmed (${episode.adjudicationState}); next follow-up ${followUpAt}`,
        statusRefreshReceiptId: receiptId,
        nextFollowUpAt: followUpAt,
        lastPayerCheckAt: at,
        revision: episode.revision + 1,
        lastVerifiedAt: at,
        evidence: [
          ...episode.evidence,
          {
            id: `ev-${receiptId}`,
            title: "Payer portal status refresh",
            kind: "portal_snapshot",
            reference: evidenceReference,
            summary: `Synthetic payer portal re-check confirmed ${episode.adjudicationState}; no remittance yet`,
            synthetic: true,
            observedAt: at,
          },
        ],
        activities: [
          ...episode.activities,
          activity(
            episode.id,
            "status.refreshed",
            `Payer status re-checked (read-only, no approval); next follow-up ${followUpAt}`,
            at,
          ),
        ],
      };

      pushObservation(next, {
        id: observationId,
        episodeId: episode.id,
        source: "payer",
        rawStatus: `Portal re-check: ${episode.adjudicationState}`,
        normalizedStatus: episode.adjudicationState,
        observedAt: at,
        lastVerifiedAt: at,
        evidenceReference,
        synthetic: true,
      });

      // Eligibility evidence advances the episode revision. Re-sign the
      // existing submit proposal against that exact revision so Allow once
      // does not reject the freshly verified preflight as stale.
      if (next.proposal?.actionType === "submit_claim") {
        const proposal = buildProposalForAction("submit_claim", next);
        next = { ...next, proposal, agentAction: proposal.title };
      }

      const event: DomainEvent = {
        type: "status.refreshed",
        id: `event-status-refresh-${receiptId}`,
        at,
        episodeId: episode.id,
        observationId,
        followUpAt,
        idempotencyKey,
      };

      this.store.replaceEpisode(next);
      this.store.appendEvent(event);
      await this.store.rememberExecution(idempotencyKey, receiptId);
      return {
        snapshot: await this.store.commit(),
        receiptId,
        followUpAt,
        idempotent: false,
        message: `Payer status re-confirmed (${episode.adjudicationState}); next follow-up ${followUpAt}.`,
      };
    } catch (error) {
      await this.store.abortMutation();
      throw error;
    }
  }

  /** Claim D: correct the rejected field and resubmit as a new claim id. */
  private async executeCorrectAndResubmit(
    episode: ClaimEpisode,
    approvalId: string,
    idempotencyKey: string,
    scope: ClientApprovalScope,
  ) {
    const agentResult = await this.agent.executeApprovedAction({
      actionType: "correct_and_resubmit",
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
        "correct_and_resubmit",
        idempotencyKey,
        agentResult.message,
      );
    }

    const at = getDemoClock();
    const originalClaimId = episode.claimId ?? `CLM-${episode.id}`;
    const correctedClaimId = `${originalClaimId}-C1`;
    const receiptId = `receipt-correct-resubmit-${episode.id}`;
    const diffArtifactId = `DocumentReference/artifact-correction-${episode.id}`;
    const oldMemberId = episode.memberId ?? `MEM-OLD-${episode.id}`;
    const newMemberId = deriveCorrectedMemberId(oldMemberId);

    // Snapshot the ORIGINAL Claim resource (by its original id, before the
    // claimId/correctedFromClaimId mutation below) so both the original and
    // the corrected claim are preserved and both appear in buildFhirBundle.
    // The corrected Claim resource itself is built by buildFhirBundle's main
    // loop from the episode's new claimId/correctedFromClaimId (which adds
    // the `related: prior` link), so only the original needs to be snapshot
    // into fhirResources here.
    const originalClaimResource = buildClaimResource(episode);

    const next: ClaimEpisode = {
      ...episode,
      claimId: correctedClaimId,
      correctedFromClaimId: originalClaimId,
      memberId: newMemberId,
      transportState: "clearinghouse_received",
      // adjudication remains unconfirmed until the payer responds to the corrected claim.
      adjudicationState: "not_found",
      resolutionState: "monitoring",
      issue: "Corrected claim resubmitted; awaiting clearinghouse/payer acknowledgment",
      agentAction: null,
      proposal: null,
      claimControlNumber: episode.claimControlNumber
        ? `${episode.claimControlNumber}-C1`
        : null,
      revision: episode.revision + 1,
      lastVerifiedAt: at,
      fhirResources: [
        ...episode.fhirResources,
        ...(originalClaimResource
          ? [originalClaimResource as unknown as Record<string, unknown>]
          : []),
      ],
      evidence: [
        ...episode.evidence,
        {
          id: `ev-correction-${episode.id}`,
          title: "Correction diff",
          kind: "artifact",
          reference: diffArtifactId,
          summary:
            `Corrected the rejected field and resubmitted ${originalClaimId} as ${correctedClaimId}. ` +
            `Member id corrected: ${oldMemberId} -> ${newMemberId}.`,
          synthetic: true,
          observedAt: at,
        },
        {
          id: `ev-${receiptId}`,
          title: "Resubmission receipt",
          kind: "receipt",
          reference: `ClaimResponse/${receiptId}`,
          summary: "Synthetic clearinghouse accepted corrected resubmission",
          synthetic: true,
          observedAt: at,
        },
      ],
      activities: [
        ...episode.activities,
        activity(
          episode.id,
          "approval.consumed",
          "Allow once consumed for correct and resubmit",
          at,
        ),
        activity(
          episode.id,
          "claim.corrected_resubmitted",
          `Corrected claim ${correctedClaimId} resubmitted (was ${originalClaimId}); ` +
            `member id corrected: ${oldMemberId} -> ${newMemberId}`,
          at,
        ),
      ],
    };

    pushObservation(next, {
      id: `obs-${episode.id}-clearinghouse-resubmit`,
      episodeId: episode.id,
      source: "clearinghouse",
      rawStatus: "Corrected claim received",
      normalizedStatus: "clearinghouse_received",
      observedAt: at,
      lastVerifiedAt: at,
      evidenceReference: diffArtifactId,
      synthetic: true,
    });

    const events: DomainEvent[] = [
      {
        type: "approval.consumed",
        id: `event-approval-${approvalId}`,
        at,
        episodeId: episode.id,
        approvalId,
        actionType: "correct_and_resubmit",
        idempotencyKey,
        proposalId: scope.proposalId,
        payloadDigest: scope.payloadDigest,
        episodeRevision: scope.episodeRevision,
        fingerprint: scope.fingerprint,
        receiptId,
      },
      {
        type: "claim.corrected_resubmitted",
        id: `event-correct-resubmit-${receiptId}`,
        at,
        episodeId: episode.id,
        originalClaimId,
        correctedClaimId,
        receiptId,
        idempotencyKey,
      },
    ];

    this.store.replaceEpisode(next);
    for (const event of events) this.store.appendEvent(event);
    await this.store.rememberExecution(idempotencyKey, receiptId);
    return {
      snapshot: await this.store.commit(),
      receiptId,
      correctedClaimId,
      idempotent: false,
    };
  }

  /** Claim E: send only the existing signed supporting note to the payer. */
  private async executeSendDocumentation(
    episode: ClaimEpisode,
    approvalId: string,
    idempotencyKey: string,
    scope: ClientApprovalScope,
  ) {
    const agentResult = await this.agent.executeApprovedAction({
      actionType: "send_documentation",
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
        "send_documentation",
        idempotencyKey,
        agentResult.message,
      );
    }

    const at = getDemoClock();
    const receiptId = `receipt-send-documentation-${episode.id}`;
    const signedNote = episode.evidence.find((e) => e.kind === "note");
    const packetReference = signedNote?.reference ?? `DocumentReference/doc-note-${episode.id}`;
    const followUpAt = addDays(at, 7);

    const next: ClaimEpisode = {
      ...episode,
      // adjudicationState intentionally unchanged (stays info_requested): sending
      // documentation never implies payer acceptance or payment.
      resolutionState: "waiting_on_payer",
      issue: `Documentation sent; awaiting payer review by ${followUpAt}`,
      agentAction: null,
      proposal: null,
      documentationReceiptId: receiptId,
      nextFollowUpAt: followUpAt,
      revision: episode.revision + 1,
      lastVerifiedAt: at,
      evidence: [
        ...episode.evidence,
        {
          id: `ev-${receiptId}`,
          title: "Documentation packet receipt",
          kind: "receipt",
          reference: `ClaimResponse/${receiptId}`,
          summary: `Sent ${packetReference} to payer in response to the documentation request`,
          synthetic: true,
          observedAt: at,
        },
      ],
      activities: [
        ...episode.activities,
        activity(
          episode.id,
          "approval.consumed",
          "Allow once consumed for send documentation",
          at,
        ),
        activity(episode.id, "documentation.sent", `Sent ${packetReference} to payer`, at),
      ],
    };

    const events: DomainEvent[] = [
      {
        type: "approval.consumed",
        id: `event-approval-${approvalId}`,
        at,
        episodeId: episode.id,
        approvalId,
        actionType: "send_documentation",
        idempotencyKey,
        proposalId: scope.proposalId,
        payloadDigest: scope.payloadDigest,
        episodeRevision: scope.episodeRevision,
        fingerprint: scope.fingerprint,
        receiptId,
      },
      {
        type: "documentation.sent",
        id: `event-send-documentation-${receiptId}`,
        at,
        episodeId: episode.id,
        packetReference,
        receiptId,
        followUpAt,
        idempotencyKey,
      },
    ];

    this.store.replaceEpisode(next);
    for (const event of events) this.store.appendEvent(event);
    await this.store.rememberExecution(idempotencyKey, receiptId);
    return {
      snapshot: await this.store.commit(),
      receiptId,
      packetReference,
      followUpAt,
      idempotent: false,
    };
  }

  /**
   * Encounter A: submit the formal appeal. Allow once starts (or resumes,
   * for a duplicate idempotencyKey) the browser tool job against the
   * fictional Northstar portal via `runApprovalGatedToolJob` -- deliberately
   * NOT `ToolJobService.create()`, which would deadlock against this
   * service's own `store.withMutationLock` (see that function's docstring).
   * The approval is only consumed once a connector receipt with a
   * confirmation exists; while the job is still running, this returns a
   * pending-verification result and leaves the proposal in place for retry.
   */
  private async executeSubmitAppeal(
    episode: ClaimEpisode,
    approvalId: string,
    idempotencyKey: string,
    scope: ClientApprovalScope,
  ) {
    const snapshot = await this.store.getSnapshot();
    const { receipt, terminal, publicJob } = await runApprovalGatedToolJob({
      sessionId: this.store.sessionId,
      sessionRevision: snapshot.sessionRevision,
      episode,
      action: "submit_appeal",
      idempotencyKey,
    });

    if (!receipt) {
      if (!terminal) {
        return this.markPendingVerification(
          episode,
          "submit_appeal",
          idempotencyKey,
          "Appeal submission job is still running; no portal confirmation yet. Retry once complete.",
        );
      }
      throw Object.assign(
        new Error(publicJob.error?.message ?? "Appeal submission failed"),
        { status: 502 },
      );
    }

    const confirmationNumber = receipt.confirmation ?? receipt.id;
    const at = getDemoClock();
    const claimId = episode.claimId ?? `CLM-${episode.id}`;
    const artifactId = `DocumentReference/artifact-appeal-${episode.id}`;
    const followUpAt = addDays(at, 14);
    const fromStage = deriveHeroStage(episode);
    const provenance = buildAppealProvenance({
      episodeId: episode.id,
      claimId,
      artifactId,
      receiptId: receipt.id,
      confirmationNumber,
      at,
    });
    const audit = buildAppealAuditEvent({
      episodeId: episode.id,
      claimId,
      artifactId,
      receiptId: receipt.id,
      confirmationNumber,
      at,
    });
    const provenanceId = `Provenance/${provenance.id}`;
    const auditId = `AuditEvent/${audit.id}`;
    const message = episode.proposal?.artifactPreview ?? "";

    const next: ClaimEpisode = {
      ...episode,
      resolutionState: "appealed",
      adjudicationState: "denied",
      issue: `Formal appeal submitted (confirmation ${confirmationNumber}); awaiting payer review by ${followUpAt}`,
      agentAction: null,
      proposal: null,
      appealReceiptId: receipt.id,
      appealConfirmationNumber: confirmationNumber,
      heroStage: "appeal_submitted",
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
          id: `ev-artifact-appeal-${episode.id}`,
          title: "Formal appeal packet",
          kind: "artifact",
          reference: artifactId,
          summary: message.slice(0, 180),
          synthetic: true,
          observedAt: at,
        },
        {
          id: `ev-${receipt.id}`,
          title: "Northstar appeal confirmation",
          kind: "receipt",
          reference: `ClaimResponse/${receipt.id}`,
          summary: receipt.summary,
          synthetic: true,
          observedAt: at,
        },
      ],
      activities: [
        ...episode.activities,
        activity(episode.id, "approval.consumed", "Allow once consumed for formal appeal", at),
        activity(episode.id, "artifact.created", `Created ${artifactId}`, at),
        activity(
          episode.id,
          "appeal.submitted",
          `Appeal submitted; Northstar confirmation ${confirmationNumber}`,
          at,
        ),
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
        actionType: "submit_appeal",
        idempotencyKey,
        proposalId: scope.proposalId,
        payloadDigest: scope.payloadDigest,
        episodeRevision: scope.episodeRevision,
        fingerprint: scope.fingerprint,
        receiptId: receipt.id,
      },
      {
        type: "artifact.created",
        id: `event-artifact-appeal-${episode.id}`,
        at,
        episodeId: episode.id,
        artifactId,
      },
      {
        type: "appeal.submitted",
        id: `event-appeal-${receipt.id}`,
        at,
        episodeId: episode.id,
        artifactId,
        receiptId: receipt.id,
        confirmationNumber,
        followUpAt,
        idempotencyKey,
      },
      {
        type: "provenance.created",
        id: `event-prov-appeal-${episode.id}`,
        at,
        episodeId: episode.id,
        provenanceId,
      },
      {
        type: "audit.created",
        id: `event-audit-appeal-${episode.id}`,
        at,
        episodeId: episode.id,
        auditId,
      },
      {
        type: "hero.stage.advanced",
        id: `event-hero-appeal-${episode.id}`,
        at,
        episodeId: episode.id,
        fromStage,
        toStage: "appeal_submitted",
        receiptId: receipt.id,
      },
    ];

    this.store.replaceEpisode(next);
    for (const event of events) this.store.appendEvent(event);
    await this.store.rememberExecution(idempotencyKey, receipt.id);
    return {
      snapshot: await this.store.commit(),
      receiptId: receipt.id,
      confirmationNumber,
      artifactId,
      followUpAt,
      provenanceId,
      auditId,
      idempotent: false,
    };
  }

  /**
   * Deterministic, connector-free follow-through: an accepted claim with no
   * remittance within the expected window is overdue. Never infers paid or
   * denied; only records that remittance is expected and overdue, which is
   * what makes `investigate_portal` (a real browser job) proposable next.
   */
  async advanceHeroFollowThrough(episodeId: string) {
    return this.store.withMutationLock(() =>
      this.advanceHeroFollowThroughUnlocked(episodeId),
    );
  }

  private async advanceHeroFollowThroughUnlocked(episodeId: string) {
    await this.store.beginMutation();
    try {
      const episode = await this.store.getEpisode(episodeId);
      if (!episode) throw Object.assign(new Error("Episode not found"), { status: 404 });
      if (episode.fixtureKey !== "encounter-a") {
        throw Object.assign(
          new Error("Follow-through is only available for the guided hero claim"),
          { status: 400 },
        );
      }
      const fromStage = deriveHeroStage(episode);
      if (fromStage !== "claim_submitted") {
        throw Object.assign(
          new Error(`Follow-through requires hero stage claim_submitted; currently ${fromStage}`),
          { status: 409 },
        );
      }

      const at = getDemoClock();
      const followUpAt = addDays(at, 10);
      const evidenceReference = `Task/followup-${episode.id}`;
      const next: ClaimEpisode = {
        ...episode,
        adjudicationState: "accepted_for_processing",
        remittanceState: "expected",
        resolutionState: "monitoring",
        heroStage: "accepted_overdue",
        issue: "Accepted for processing; remittance overdue with no payer response",
        agentAction: "Investigate payer portal",
        nextFollowUpAt: followUpAt,
        revision: episode.revision + 1,
        lastVerifiedAt: at,
        evidence: [
          ...episode.evidence,
          {
            id: `ev-overdue-${episode.id}`,
            title: "Overdue remittance check",
            kind: "note",
            reference: evidenceReference,
            summary:
              "No remittance received within the expected window; a payer portal investigation is required.",
            synthetic: true,
            observedAt: at,
          },
        ],
        activities: [
          ...episode.activities,
          activity(
            episode.id,
            "hero.stage.advanced",
            "Advanced to accepted overdue (deterministic follow-through, no connector)",
            at,
          ),
        ],
      };

      pushObservation(next, {
        id: `obs-${episode.id}-payer-overdue`,
        episodeId: episode.id,
        source: "payer",
        rawStatus: "Accepted for processing; no remittance",
        normalizedStatus: "accepted_for_processing",
        observedAt: at,
        lastVerifiedAt: at,
        evidenceReference,
        synthetic: true,
      });

      const event: DomainEvent = {
        type: "hero.stage.advanced",
        id: `event-hero-followthrough-${episode.id}-${at}`,
        at,
        episodeId: episode.id,
        fromStage,
        toStage: "accepted_overdue",
      };

      this.store.replaceEpisode(next);
      this.store.appendEvent(event);
      return {
        snapshot: await this.store.commit(),
        heroStage: "accepted_overdue" as const,
      };
    } catch (error) {
      await this.store.abortMutation();
      throw error;
    }
  }

  /**
   * Persists a normalized Stedi 270/271 result as durable episode evidence
   * (never the raw X12). Idempotent: once `eligibilityReceiptId` is set this
   * returns the existing receipt/summary without mutating state, so callers
   * (see `/api/episodes/[id]/eligibility`) can skip calling Stedi again.
   */
  async recordEligibilityCheck(episodeId: string, result: EligibilityCheckInput) {
    return this.store.withMutationLock(() =>
      this.recordEligibilityCheckUnlocked(episodeId, result),
    );
  }

  private async recordEligibilityCheckUnlocked(
    episodeId: string,
    result: EligibilityCheckInput,
  ) {
    await this.store.beginMutation();
    try {
      const episode = await this.store.getEpisode(episodeId);
      if (!episode) throw Object.assign(new Error("Episode not found"), { status: 404 });
      if (episode.fixtureKey !== "encounter-a") {
        throw Object.assign(
          new Error("Live Stedi eligibility is limited to the approved synthetic encounter."),
          { status: 400 },
        );
      }

      if (episode.eligibilityReceiptId) {
        await this.store.abortMutation();
        return {
          snapshot: await this.store.getSnapshot(),
          receiptId: episode.eligibilityReceiptId,
          summary: episode.eligibilitySummary ?? null,
          idempotent: true,
        };
      }

      const at = getDemoClock();
      const receiptId = `receipt-eligibility-${episode.id}-${at}`;
      const evidenceReference = `Coverage/eligibility-${result.checkId}`;
      const summary: EligibilitySummary = {
        checkId: result.checkId,
        applicationMode: result.applicationMode,
        activeCoverage: result.activeCoverage,
        activeBenefitCount: result.activeBenefitCount,
        planNames: result.planNames,
        hasRaw271: result.hasRaw271,
      };

      const next: ClaimEpisode = {
        ...episode,
        coverageActive: result.activeCoverage,
        eligibilityReceiptId: receiptId,
        eligibilitySummary: summary,
        heroStage: episode.heroStage ?? "eligibility_checked",
        revision: episode.revision + 1,
        lastVerifiedAt: at,
        evidence: [
          ...episode.evidence,
          {
            id: `ev-${receiptId}`,
            title: "Stedi 270/271 eligibility check",
            kind: "receipt",
            reference: evidenceReference,
            summary: `Synthetic Stedi 270/271 confirmed ${
              result.activeCoverage ? "active" : "inactive"
            } coverage (test mode, ${result.activeBenefitCount} active benefit(s)${
              result.planNames.length ? `: ${result.planNames.join(", ")}` : ""
            }; raw 271 ${result.hasRaw271 ? "on file" : "not captured"}).`,
            synthetic: true,
            observedAt: at,
          },
        ],
        activities: [
          ...episode.activities,
          activity(
            episode.id,
            "eligibility.checked",
            `Synthetic Stedi eligibility check confirmed ${
              result.activeCoverage ? "active" : "inactive"
            } coverage`,
            at,
          ),
        ],
      };

      pushObservation(next, {
        id: `obs-${episode.id}-eligibility-${at}`,
        episodeId: episode.id,
        source: "payer",
        rawStatus: `Eligibility check ${result.activeCoverage ? "active" : "inactive"}`,
        normalizedStatus: result.activeCoverage ? "active_coverage" : "inactive_coverage",
        observedAt: at,
        lastVerifiedAt: at,
        evidenceReference,
        synthetic: true,
      });

      const event: DomainEvent = {
        type: "eligibility.checked",
        id: `event-eligibility-${episode.id}-${at}`,
        at,
        episodeId: episode.id,
        receiptId,
        checkId: result.checkId,
        activeCoverage: result.activeCoverage,
      };

      this.store.replaceEpisode(next);
      this.store.appendEvent(event);
      return {
        snapshot: await this.store.commit(),
        receiptId,
        summary,
        idempotent: false,
      };
    } catch (error) {
      await this.store.abortMutation();
      throw error;
    }
  }

  private async markPendingVerification(
    episode: ClaimEpisode,
    actionType: ActionType,
    idempotencyKey: string,
    message: string,
  ) {
    const at = getDemoClock();
    const next: ClaimEpisode = {
      ...episode,
      // Keep proposal for safe retry after verification; no success mutation.
      // claim-b's read-only refresh has no proposal and must never enter
      // approval_required, so it keeps its existing resolutionState.
      resolutionState:
        actionType === "refresh_payer_status"
          ? episode.resolutionState
          : "approval_required",
      issue: `Pending verification: ${message}`,
      agentAction:
        actionType === "refresh_payer_status" ? episode.agentAction : "Retry after verification",
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
      snapshot: await this.store.commit(),
      receiptId: null,
      pendingVerification: true,
      message,
      idempotent: false,
    };
  }
}
