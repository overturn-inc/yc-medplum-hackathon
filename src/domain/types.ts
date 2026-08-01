/** Multi-axis claim episode domain types. */

import type { HeroStage } from "./hero";

export type EncounterState =
  | "scheduled"
  | "arrived"
  | "completed"
  | "note_signed";

export type ChargeState =
  | "uncoded"
  | "coding_blocked"
  | "ready"
  | "claim_created";

export type TransportState =
  | "unsent"
  | "sent"
  | "clearinghouse_received"
  | "clearinghouse_rejected"
  | "payer_delivered";

export type AdjudicationState =
  | "not_found"
  | "accepted_for_processing"
  | "pending"
  | "info_requested"
  | "denied"
  | "partial"
  | "paid";

export type RemittanceState = "none" | "expected" | "received";
export type SettlementState = "unknown" | "pending" | "received" | "failed";
export type PostingState = "unposted" | "posted" | "reconciled" | "mismatch";

export type ResolutionState =
  | "monitoring"
  | "investigating"
  | "waiting_on_practice"
  | "waiting_on_payer"
  | "approval_required"
  | "corrected"
  | "rebilled"
  | "reprocessing"
  | "appealed"
  | "closed";

export type ObservationSource =
  | "pms"
  | "clearinghouse"
  | "payer"
  | "remittance"
  | "posting";

export type PrimaryBucket =
  | "needs_claim"
  | "ready_to_submit"
  | "rejected_before_adjudication"
  | "awaiting_payer"
  | "action_required"
  | "denied_under_resolution"
  | "paid_needs_posting"
  | "reconciled_or_closed";

export type OverlayFlag =
  | "follow_up_due"
  | "source_discrepancy"
  | "approval_required";

export type DiscrepancyRuleId =
  | "status_conflict"
  | "status_stale"
  | "payment_unverified";

export type ActionType =
  | "submit_claim"
  | "request_reprocessing"
  | "send_documentation"
  | "submit_appeal"
  | "post_payment"
  | "refresh_payer_status"
  | "correct_and_resubmit";

export type HealthcareMode = "local" | "medplum";
export type AgentMode = "synthetic" | "bff";

export type AgentIntent =
  | "status"
  | "reason"
  | "evidence"
  | "next_action"
  | "request_action"
  | "unsupported";

export interface ConversationMessage {
  id: string;
  episodeId: string;
  role: "user" | "assistant";
  content: string;
  intent: AgentIntent;
  citations: Array<{ reference: string; source: string; observedAt: string; title: string }>;
  createdAt: string;
  clientRequestId?: string;
  proposalId?: string;
}

export interface SourceObservation {
  id: string;
  episodeId: string;
  source: ObservationSource;
  rawStatus: string;
  normalizedStatus: string;
  observedAt: string;
  lastVerifiedAt: string;
  evidenceReference: string;
  synthetic: boolean;
}

export interface ServiceLine {
  id: string;
  cpt: string;
  description: string;
  units: number;
  charge: number;
  diagnosisPointers: string[];
}

export interface FinancialProjection {
  billed: number;
  allowed: number | null;
  paid: number | null;
  adjustment: number | null;
  patientResponsibility: number | null;
  posted: number | null;
}

export interface EvidenceItem {
  id: string;
  title: string;
  kind:
    | "authorization"
    | "portal_snapshot"
    | "raw_277"
    | "raw_835"
    | "era_pdf"
    | "note"
    | "artifact"
    | "receipt"
    | "pms_posting";
  reference: string;
  summary: string;
  synthetic: boolean;
  observedAt: string;
}

export interface DiscrepancyFinding {
  ruleId: DiscrepancyRuleId;
  episodeId: string;
  summary: string;
  comparedSources: Array<{
    source: ObservationSource;
    observedAt: string;
    normalizedStatus: string;
    evidenceReference: string;
  }>;
  evidenceReferences: string[];
}

export interface AgentProposal {
  id: string;
  episodeId: string;
  actionType: ActionType;
  title: string;
  whatIFound: string;
  evidenceUsed: string[];
  proposedAction: string;
  artifactPreview: string;
  payloadDigest: string;
  episodeRevision: number;
  fingerprint: string;
  createdAt: string;
  /** Synthetic member-id correction preview for Claim D (and similar). */
  memberIdCorrection?: { oldMemberId: string; newMemberId: string };
}

export interface ApprovalReceipt {
  id: string;
  proposalId: string;
  episodeId: string;
  actionType: ActionType;
  payloadDigest: string;
  episodeRevision: number;
  decision: "allow_once" | "deny";
  decidedAt: string;
  idempotencyKey: string;
  fingerprint: string;
}

export interface ExecutionReceipt {
  id: string;
  approvalId: string;
  episodeId: string;
  actionType: ActionType;
  idempotencyKey: string;
  outcome: "success" | "pending_verification" | "failed";
  message: string;
  executedAt: string;
  evidenceReference: string;
}

export interface ActivityEvent {
  id: string;
  episodeId: string;
  at: string;
  kind: string;
  summary: string;
  synthetic: boolean;
}

/**
 * Normalized Stedi 270/271 eligibility result durably persisted on the
 * episode. Deliberately excludes raw X12; `hasRaw271` only records that a
 * 271 payload was returned, never its contents.
 */
export interface EligibilitySummary {
  checkId: string;
  applicationMode: string;
  activeCoverage: boolean;
  activeBenefitCount: number;
  planNames: string[];
  hasRaw271: boolean;
}

export interface ClaimEpisode {
  id: string;
  fixtureKey:
    | "encounter-a"
    | "claim-a"
    | "claim-b"
    | "claim-c"
    | "claim-d"
    | "claim-e"
    | "claim-f"
    | "connected-claim"
    | "connected-encounter";
  patientName: string;
  patientId: string;
  payerName: string;
  payerId: string;
  providerName: string;
  dateOfService: string;
  claimId: string | null;
  cpt: string | null;
  billedAmount: number;
  encounterState: EncounterState;
  chargeState: ChargeState;
  transportState: TransportState;
  adjudicationState: AdjudicationState;
  remittanceState: RemittanceState;
  settlementState: SettlementState;
  postingState: PostingState;
  resolutionState: ResolutionState;
  noteState: "draft" | "final";
  codingReady: boolean;
  coverageActive: boolean;
  owner: string;
  issue: string | null;
  agentAction: string | null;
  nextFollowUpAt: string | null;
  lastPayerCheckAt: string | null;
  lastVerifiedAt: string;
  revision: number;
  observations: SourceObservation[];
  evidence: EvidenceItem[];
  financial: FinancialProjection;
  serviceLines: ServiceLine[];
  diagnoses: Array<{ code: string; display: string }>;
  discrepancies: DiscrepancyFinding[];
  proposal: AgentProposal | null;
  activities: ActivityEvent[];
  submissionReceiptId: string | null;
  reprocessingReceiptId: string | null;
  remittanceControlNumber: string | null;
  claimControlNumber: string | null;
  /** Materialized FHIR resources created by approved actions (Provenance, AuditEvent, etc.). */
  fhirResources: Array<Record<string, unknown>>;
  /** Set once a corrected claim has been resubmitted in place of this episode's original claim. */
  correctedFromClaimId?: string | null;
  /** Execution receipt id once a documentation packet has been sent to the payer. */
  documentationReceiptId?: string | null;
  /** Execution receipt id once a payer status refresh has been recorded. */
  statusRefreshReceiptId?: string | null;
  /**
   * Source-of-truth member/subscriber id on file for this episode. For
   * claim-d, the seeded value is intentionally stale (the actual cause of
   * the clearinghouse rejection); `correct_and_resubmit` corrects it to a
   * new synthetic id (see `deriveCorrectedMemberId`) and this field then
   * reflects the corrected value.
   */
  memberId?: string | null;
  /** Conversational agent turns scoped to this episode. */
  conversation?: ConversationMessage[];
  /** Guided hero stage for encounter-a only. */
  heroStage?: HeroStage;
  /** Durable Stedi eligibility receipt id (normalized; no raw X12). */
  eligibilityReceiptId?: string | null;
  /** Normalized eligibility summary persisted alongside the receipt id; never the raw 271. */
  eligibilitySummary?: EligibilitySummary | null;
  /** Durable Northstar portal investigation receipt id. */
  portalInvestigationReceiptId?: string | null;
  /** Durable Deepgram voice session receipt id. */
  voiceSessionReceiptId?: string | null;
  /** Durable portal recheck receipt confirming denial upheld. */
  denialUpheldReceiptId?: string | null;
  /** Durable appeal submission receipt id. */
  appealReceiptId?: string | null;
  /** Fictional portal appeal confirmation number. */
  appealConfirmationNumber?: string | null;
}

export interface DemoSnapshot {
  demoClock: string;
  sessionRevision: number;
  healthcareMode: HealthcareMode;
  agentMode: AgentMode;
  episodes: ClaimEpisode[];
  events: DomainEvent[];
  /** Fail-closed store degradation; Reset recovers without deleting connected resources. */
  degraded?: {
    reason: string;
    recovery: string;
  } | null;
  agentStatus?: {
    available: boolean;
    error?: string;
  };
}

export type DomainEvent =
  | {
      type: "demo.session.reset";
      id: string;
      at: string;
      sessionRevision: number;
    }
  | {
      type: "proposal.created";
      id: string;
      at: string;
      episodeId: string;
      proposalId: string;
    }
  | {
      type: "proposal.denied";
      id: string;
      at: string;
      episodeId: string;
      proposalId: string;
      actionType: ActionType;
    }
  | {
      type: "approval.consumed";
      id: string;
      at: string;
      episodeId: string;
      approvalId: string;
      actionType: ActionType;
      idempotencyKey: string;
      /** Immutable reviewed scope bound to the execution receipt. */
      proposalId: string;
      payloadDigest: string;
      episodeRevision: number;
      fingerprint: string;
      receiptId: string;
    }
  | {
      type: "episode.projected";
      id: string;
      at: string;
      episodeId: string;
      schemaVersion: 1;
      episode: ClaimEpisode;
    }
  | {
      type: "claim.submitted";
      id: string;
      at: string;
      episodeId: string;
      claimId: string;
      receiptId: string;
      idempotencyKey: string;
    }
  | {
      type: "reprocessing.requested";
      id: string;
      at: string;
      episodeId: string;
      artifactId: string;
      receiptId: string;
      followUpAt: string;
      idempotencyKey: string;
    }
  | {
      type: "observation.appended";
      id: string;
      at: string;
      episodeId: string;
      observationId: string;
    }
  | {
      type: "artifact.created";
      id: string;
      at: string;
      episodeId: string;
      artifactId: string;
    }
  | {
      type: "provenance.created";
      id: string;
      at: string;
      episodeId: string;
      provenanceId: string;
    }
  | {
      type: "audit.created";
      id: string;
      at: string;
      episodeId: string;
      auditId: string;
    }
  | {
      type: "execution.pending_verification";
      id: string;
      at: string;
      episodeId: string;
      actionType: ActionType;
      idempotencyKey: string;
      message: string;
    }
  | {
      type: "conversation.message.appended";
      id: string;
      at: string;
      sessionId: string;
      episodeId: string;
      messageId: string;
      role: "user" | "assistant";
      intent: AgentIntent;
      clientRequestId?: string;
    }
  | {
      type: "status.refreshed";
      id: string;
      at: string;
      episodeId: string;
      observationId: string;
      followUpAt: string;
      idempotencyKey: string;
    }
  | {
      type: "claim.corrected_resubmitted";
      id: string;
      at: string;
      episodeId: string;
      originalClaimId: string;
      correctedClaimId: string;
      receiptId: string;
      idempotencyKey: string;
    }
  | {
      type: "documentation.sent";
      id: string;
      at: string;
      episodeId: string;
      packetReference: string;
      receiptId: string;
      followUpAt: string;
      idempotencyKey: string;
    }
  | {
      type: "action.reserved";
      id: string;
      at: string;
      episodeId: string;
      actionType: ActionType;
      clientRequestId: string;
      reservationId: string;
    }
  | {
      type: "hero.stage.advanced";
      id: string;
      at: string;
      episodeId: string;
      fromStage: string;
      toStage: string;
      receiptId?: string;
    }
  | {
      type: "tool_job.completed";
      id: string;
      at: string;
      episodeId: string;
      jobId: string;
      action: string;
      receiptId: string;
    }
  | {
      type: "eligibility.checked";
      id: string;
      at: string;
      episodeId: string;
      receiptId: string;
      checkId: string;
      activeCoverage: boolean;
    }
  | {
      type: "appeal.submitted";
      id: string;
      at: string;
      episodeId: string;
      artifactId: string;
      receiptId: string;
      confirmationNumber: string;
      followUpAt: string;
      idempotencyKey: string;
    };
