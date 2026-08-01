/**
 * Strict Zod v4 schemas mirroring src/domain/types.ts.
 *
 * These schemas are the runtime validation boundary for every DomainEvent
 * appended to the NDJSON ledger and for every ClaimEpisode/DemoSnapshot read
 * back from disk or replayed from history. `.strict()` is used on every
 * object so unknown/extra fields are rejected (no additionalProperties).
 */
import { z } from "zod";
import { HERO_STAGES } from "./hero";
import type {
  ActionType,
  ActivityEvent,
  AgentIntent,
  AgentMode,
  AgentProposal,
  ApprovalReceipt,
  ClaimEpisode,
  ConversationMessage,
  DemoSnapshot,
  DiscrepancyFinding,
  DomainEvent,
  EligibilitySummary,
  EvidenceItem,
  ExecutionReceipt,
  FinancialProjection,
  HealthcareMode,
  ServiceLine,
  SourceObservation,
} from "./types";

export const heroStageSchema = z.enum(HERO_STAGES);

/* ------------------------------------------------------------------ */
/* Primitive enums                                                     */
/* ------------------------------------------------------------------ */

export const encounterStateSchema = z.enum([
  "scheduled",
  "arrived",
  "completed",
  "note_signed",
]);

export const chargeStateSchema = z.enum([
  "uncoded",
  "coding_blocked",
  "ready",
  "claim_created",
]);

export const transportStateSchema = z.enum([
  "unsent",
  "sent",
  "clearinghouse_received",
  "clearinghouse_rejected",
  "payer_delivered",
]);

export const adjudicationStateSchema = z.enum([
  "not_found",
  "accepted_for_processing",
  "pending",
  "info_requested",
  "denied",
  "partial",
  "paid",
]);

export const remittanceStateSchema = z.enum(["none", "expected", "received"]);
export const settlementStateSchema = z.enum([
  "unknown",
  "pending",
  "received",
  "failed",
]);
export const postingStateSchema = z.enum([
  "unposted",
  "posted",
  "reconciled",
  "mismatch",
]);

export const resolutionStateSchema = z.enum([
  "monitoring",
  "investigating",
  "waiting_on_practice",
  "waiting_on_payer",
  "approval_required",
  "corrected",
  "rebilled",
  "reprocessing",
  "appealed",
  "closed",
]);

export const observationSourceSchema = z.enum([
  "pms",
  "clearinghouse",
  "payer",
  "remittance",
  "posting",
]);

export const primaryBucketSchema = z.enum([
  "needs_claim",
  "ready_to_submit",
  "rejected_before_adjudication",
  "awaiting_payer",
  "action_required",
  "denied_under_resolution",
  "paid_needs_posting",
  "reconciled_or_closed",
]);

export const overlayFlagSchema = z.enum([
  "follow_up_due",
  "source_discrepancy",
  "approval_required",
]);

export const discrepancyRuleIdSchema = z.enum([
  "status_conflict",
  "status_stale",
  "payment_unverified",
]);

export const actionTypeSchema = z.enum([
  "submit_claim",
  "request_reprocessing",
  "send_documentation",
  "submit_appeal",
  "post_payment",
  "refresh_payer_status",
  "correct_and_resubmit",
]) satisfies z.ZodType<ActionType>;

export const healthcareModeSchema = z.enum([
  "local",
  "medplum",
]) satisfies z.ZodType<HealthcareMode>;

export const agentModeSchema = z.enum([
  "synthetic",
  "bff",
]) satisfies z.ZodType<AgentMode>;

export const agentIntentSchema = z.enum([
  "status",
  "reason",
  "evidence",
  "next_action",
  "request_action",
  "unsupported",
]) satisfies z.ZodType<AgentIntent>;

export const fixtureKeySchema = z.enum([
  "encounter-a",
  "claim-a",
  "claim-b",
  "claim-c",
  "claim-d",
  "claim-e",
  "claim-f",
  "connected-claim",
  "connected-encounter",
]);

export const evidenceKindSchema = z.enum([
  "authorization",
  "portal_snapshot",
  "raw_277",
  "raw_835",
  "era_pdf",
  "note",
  "artifact",
  "receipt",
  "pms_posting",
]);

/* ------------------------------------------------------------------ */
/* Nested value objects                                                */
/* ------------------------------------------------------------------ */

export const sourceObservationSchema = z
  .object({
    id: z.string().min(1),
    episodeId: z.string().min(1),
    source: observationSourceSchema,
    rawStatus: z.string().min(1),
    normalizedStatus: z.string().min(1),
    observedAt: z.string().min(1),
    lastVerifiedAt: z.string().min(1),
    evidenceReference: z.string().min(1),
    synthetic: z.boolean(),
  })
  .strict() satisfies z.ZodType<SourceObservation>;

export const serviceLineSchema = z
  .object({
    id: z.string().min(1),
    cpt: z.string().min(1),
    description: z.string().min(1),
    units: z.number(),
    charge: z.number(),
    diagnosisPointers: z.array(z.string()),
  })
  .strict() satisfies z.ZodType<ServiceLine>;

export const financialProjectionSchema = z
  .object({
    billed: z.number(),
    allowed: z.number().nullable(),
    paid: z.number().nullable(),
    adjustment: z.number().nullable(),
    patientResponsibility: z.number().nullable(),
    posted: z.number().nullable(),
  })
  .strict() satisfies z.ZodType<FinancialProjection>;

export const evidenceItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    kind: evidenceKindSchema,
    reference: z.string().min(1),
    summary: z.string().min(1),
    synthetic: z.boolean(),
    observedAt: z.string().min(1),
  })
  .strict() satisfies z.ZodType<EvidenceItem>;

export const eligibilitySummarySchema = z
  .object({
    checkId: z.string().min(1),
    applicationMode: z.string().min(1),
    activeCoverage: z.boolean(),
    activeBenefitCount: z.number(),
    planNames: z.array(z.string()),
    hasRaw271: z.boolean(),
  })
  .strict() satisfies z.ZodType<EligibilitySummary>;

export const discrepancyComparedSourceSchema = z
  .object({
    source: observationSourceSchema,
    observedAt: z.string().min(1),
    normalizedStatus: z.string().min(1),
    evidenceReference: z.string().min(1),
  })
  .strict();

export const discrepancyFindingSchema = z
  .object({
    ruleId: discrepancyRuleIdSchema,
    episodeId: z.string().min(1),
    summary: z.string().min(1),
    comparedSources: z.array(discrepancyComparedSourceSchema),
    evidenceReferences: z.array(z.string()),
  })
  .strict() satisfies z.ZodType<DiscrepancyFinding>;

export const agentProposalSchema = z
  .object({
    id: z.string().min(1),
    episodeId: z.string().min(1),
    actionType: actionTypeSchema,
    title: z.string().min(1),
    whatIFound: z.string().min(1),
    evidenceUsed: z.array(z.string()),
    proposedAction: z.string().min(1),
    artifactPreview: z.string(),
    payloadDigest: z.string().min(1),
    episodeRevision: z.number().int(),
    fingerprint: z.string().min(1),
    createdAt: z.string().min(1),
    memberIdCorrection: z
      .object({
        oldMemberId: z.string().min(1),
        newMemberId: z.string().min(1),
      })
      .optional(),
  })
  .strict() satisfies z.ZodType<AgentProposal>;

export const approvalReceiptSchema = z
  .object({
    id: z.string().min(1),
    proposalId: z.string().min(1),
    episodeId: z.string().min(1),
    actionType: actionTypeSchema,
    payloadDigest: z.string().min(1),
    episodeRevision: z.number().int(),
    decision: z.enum(["allow_once", "deny"]),
    decidedAt: z.string().min(1),
    idempotencyKey: z.string().min(1),
    fingerprint: z.string().min(1),
  })
  .strict() satisfies z.ZodType<ApprovalReceipt>;

export const executionReceiptSchema = z
  .object({
    id: z.string().min(1),
    approvalId: z.string().min(1),
    episodeId: z.string().min(1),
    actionType: actionTypeSchema,
    idempotencyKey: z.string().min(1),
    outcome: z.enum(["success", "pending_verification", "failed"]),
    message: z.string(),
    executedAt: z.string().min(1),
    evidenceReference: z.string().min(1),
  })
  .strict() satisfies z.ZodType<ExecutionReceipt>;

export const activityEventSchema = z
  .object({
    id: z.string().min(1),
    episodeId: z.string().min(1),
    at: z.string().min(1),
    kind: z.string().min(1),
    summary: z.string().min(1),
    synthetic: z.boolean(),
  })
  .strict() satisfies z.ZodType<ActivityEvent>;

export const conversationCitationSchema = z
  .object({
    reference: z.string().min(1),
    source: z.string().min(1),
    observedAt: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();

export const conversationMessageSchema = z
  .object({
    id: z.string().min(1),
    episodeId: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    intent: agentIntentSchema,
    citations: z.array(conversationCitationSchema),
    createdAt: z.string().min(1),
    clientRequestId: z.string().min(1).optional(),
    proposalId: z.string().min(1).optional(),
  })
  .strict() satisfies z.ZodType<ConversationMessage>;

/* ------------------------------------------------------------------ */
/* ClaimEpisode                                                        */
/* ------------------------------------------------------------------ */

export const diagnosisSchema = z
  .object({
    code: z.string().min(1),
    display: z.string().min(1),
  })
  .strict();

export const claimEpisodeSchema = z
  .object({
    id: z.string().min(1),
    fixtureKey: fixtureKeySchema,
    patientName: z.string().min(1),
    patientId: z.string().min(1),
    payerName: z.string().min(1),
    payerId: z.string().min(1),
    providerName: z.string().min(1),
    dateOfService: z.string().min(1),
    claimId: z.string().nullable(),
    cpt: z.string().nullable(),
    billedAmount: z.number(),
    encounterState: encounterStateSchema,
    chargeState: chargeStateSchema,
    transportState: transportStateSchema,
    adjudicationState: adjudicationStateSchema,
    remittanceState: remittanceStateSchema,
    settlementState: settlementStateSchema,
    postingState: postingStateSchema,
    resolutionState: resolutionStateSchema,
    noteState: z.enum(["draft", "final"]),
    codingReady: z.boolean(),
    coverageActive: z.boolean(),
    owner: z.string().min(1),
    issue: z.string().nullable(),
    agentAction: z.string().nullable(),
    nextFollowUpAt: z.string().nullable(),
    lastPayerCheckAt: z.string().nullable(),
    lastVerifiedAt: z.string().min(1),
    revision: z.number().int(),
    observations: z.array(sourceObservationSchema),
    evidence: z.array(evidenceItemSchema),
    financial: financialProjectionSchema,
    serviceLines: z.array(serviceLineSchema),
    diagnoses: z.array(diagnosisSchema),
    discrepancies: z.array(discrepancyFindingSchema),
    proposal: agentProposalSchema.nullable(),
    activities: z.array(activityEventSchema),
    submissionReceiptId: z.string().nullable(),
    reprocessingReceiptId: z.string().nullable(),
    remittanceControlNumber: z.string().nullable(),
    claimControlNumber: z.string().nullable(),
    fhirResources: z.array(z.record(z.string(), z.unknown())),
    correctedFromClaimId: z.string().nullable().optional(),
    documentationReceiptId: z.string().nullable().optional(),
    statusRefreshReceiptId: z.string().nullable().optional(),
    memberId: z.string().nullable().optional(),
    conversation: z.array(conversationMessageSchema).optional().default([]),
    heroStage: heroStageSchema.optional(),
    eligibilityReceiptId: z.string().nullable().optional(),
    eligibilitySummary: eligibilitySummarySchema.nullable().optional(),
    portalInvestigationReceiptId: z.string().nullable().optional(),
    voiceSessionReceiptId: z.string().nullable().optional(),
    denialUpheldReceiptId: z.string().nullable().optional(),
    appealReceiptId: z.string().nullable().optional(),
    appealConfirmationNumber: z.string().nullable().optional(),
  })
  .strict() satisfies z.ZodType<ClaimEpisode>;

/* ------------------------------------------------------------------ */
/* DomainEvent (discriminated union)                                   */
/* ------------------------------------------------------------------ */

const demoSessionResetEventSchema = z
  .object({
    type: z.literal("demo.session.reset"),
    id: z.string().min(1),
    at: z.string().min(1),
    sessionRevision: z.number().int(),
  })
  .strict();

const proposalCreatedEventSchema = z
  .object({
    type: z.literal("proposal.created"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    proposalId: z.string().min(1),
  })
  .strict();

const proposalDeniedEventSchema = z
  .object({
    type: z.literal("proposal.denied"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    proposalId: z.string().min(1),
    actionType: actionTypeSchema,
  })
  .strict();

const approvalConsumedEventSchema = z
  .object({
    type: z.literal("approval.consumed"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    approvalId: z.string().min(1),
    actionType: actionTypeSchema,
    idempotencyKey: z.string().min(1),
    proposalId: z.string().min(1),
    payloadDigest: z.string().min(1),
    episodeRevision: z.number().int(),
    fingerprint: z.string().min(1),
    receiptId: z.string().min(1),
  })
  .strict();

const episodeProjectedEventSchema = z
  .object({
    type: z.literal("episode.projected"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    schemaVersion: z.literal(1),
    episode: claimEpisodeSchema,
  })
  .strict();

const claimSubmittedEventSchema = z
  .object({
    type: z.literal("claim.submitted"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    claimId: z.string().min(1),
    receiptId: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const reprocessingRequestedEventSchema = z
  .object({
    type: z.literal("reprocessing.requested"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    artifactId: z.string().min(1),
    receiptId: z.string().min(1),
    followUpAt: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const observationAppendedEventSchema = z
  .object({
    type: z.literal("observation.appended"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    observationId: z.string().min(1),
  })
  .strict();

const artifactCreatedEventSchema = z
  .object({
    type: z.literal("artifact.created"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    artifactId: z.string().min(1),
  })
  .strict();

const provenanceCreatedEventSchema = z
  .object({
    type: z.literal("provenance.created"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    provenanceId: z.string().min(1),
  })
  .strict();

const auditCreatedEventSchema = z
  .object({
    type: z.literal("audit.created"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    auditId: z.string().min(1),
  })
  .strict();

const executionPendingVerificationEventSchema = z
  .object({
    type: z.literal("execution.pending_verification"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    actionType: actionTypeSchema,
    idempotencyKey: z.string().min(1),
    message: z.string(),
  })
  .strict();

const conversationMessageAppendedEventSchema = z
  .object({
    type: z.literal("conversation.message.appended"),
    id: z.string().min(1),
    at: z.string().min(1),
    sessionId: z.string().min(1),
    episodeId: z.string().min(1),
    messageId: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    intent: agentIntentSchema,
    clientRequestId: z.string().min(1).optional(),
  })
  .strict();

const statusRefreshedEventSchema = z
  .object({
    type: z.literal("status.refreshed"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    observationId: z.string().min(1),
    followUpAt: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const claimCorrectedResubmittedEventSchema = z
  .object({
    type: z.literal("claim.corrected_resubmitted"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    originalClaimId: z.string().min(1),
    correctedClaimId: z.string().min(1),
    receiptId: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const documentationSentEventSchema = z
  .object({
    type: z.literal("documentation.sent"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    packetReference: z.string().min(1),
    receiptId: z.string().min(1),
    followUpAt: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const actionReservedEventSchema = z
  .object({
    type: z.literal("action.reserved"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    actionType: actionTypeSchema,
    clientRequestId: z.string().min(1),
    reservationId: z.string().min(1),
  })
  .strict();

const heroStageAdvancedEventSchema = z
  .object({
    type: z.literal("hero.stage.advanced"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    fromStage: z.string().min(1),
    toStage: z.string().min(1),
    receiptId: z.string().min(1).optional(),
  })
  .strict();

const toolJobCompletedEventSchema = z
  .object({
    type: z.literal("tool_job.completed"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    jobId: z.string().min(1),
    action: z.string().min(1),
    receiptId: z.string().min(1),
  })
  .strict();

const eligibilityCheckedEventSchema = z
  .object({
    type: z.literal("eligibility.checked"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    receiptId: z.string().min(1),
    checkId: z.string().min(1),
    activeCoverage: z.boolean(),
  })
  .strict();

const appealSubmittedEventSchema = z
  .object({
    type: z.literal("appeal.submitted"),
    id: z.string().min(1),
    at: z.string().min(1),
    episodeId: z.string().min(1),
    artifactId: z.string().min(1),
    receiptId: z.string().min(1),
    confirmationNumber: z.string().min(1),
    followUpAt: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

export const domainEventSchema = z.discriminatedUnion("type", [
  demoSessionResetEventSchema,
  proposalCreatedEventSchema,
  proposalDeniedEventSchema,
  approvalConsumedEventSchema,
  episodeProjectedEventSchema,
  claimSubmittedEventSchema,
  reprocessingRequestedEventSchema,
  observationAppendedEventSchema,
  artifactCreatedEventSchema,
  provenanceCreatedEventSchema,
  auditCreatedEventSchema,
  executionPendingVerificationEventSchema,
  conversationMessageAppendedEventSchema,
  statusRefreshedEventSchema,
  claimCorrectedResubmittedEventSchema,
  documentationSentEventSchema,
  actionReservedEventSchema,
  heroStageAdvancedEventSchema,
  toolJobCompletedEventSchema,
  eligibilityCheckedEventSchema,
  appealSubmittedEventSchema,
]) satisfies z.ZodType<DomainEvent>;

/* ------------------------------------------------------------------ */
/* DemoSnapshot                                                         */
/* ------------------------------------------------------------------ */

export const demoSnapshotSchema = z
  .object({
    demoClock: z.string().min(1),
    sessionRevision: z.number().int(),
    healthcareMode: healthcareModeSchema,
    agentMode: agentModeSchema,
    episodes: z.array(claimEpisodeSchema),
    events: z.array(domainEventSchema),
    degraded: z
      .object({
        reason: z.string(),
        recovery: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
    agentStatus: z
      .object({
        available: z.boolean(),
        error: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<DemoSnapshot>;

/* ------------------------------------------------------------------ */
/* Public parsing helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Validate and narrow a raw value into a DomainEvent. Throws a ZodError
 * (via `.parse`) on unknown event types, missing fields, or extra fields.
 * Use before appending to the event ledger and when replaying events read
 * back from disk.
 */
export function parseDomainEvent(raw: unknown): DomainEvent {
  return domainEventSchema.parse(raw);
}

/** Non-throwing variant of {@link parseDomainEvent}. */
export function safeParseDomainEvent(
  raw: unknown,
): z.ZodSafeParseResult<DomainEvent> {
  return domainEventSchema.safeParse(raw) as z.ZodSafeParseResult<DomainEvent>;
}

/** Validate and narrow a raw value into a ClaimEpisode projection payload. */
export function parseClaimEpisode(raw: unknown): ClaimEpisode {
  return claimEpisodeSchema.parse(raw);
}

/** Non-throwing variant of {@link parseClaimEpisode}. */
export function safeParseClaimEpisode(
  raw: unknown,
): z.ZodSafeParseResult<ClaimEpisode> {
  return claimEpisodeSchema.safeParse(raw) as z.ZodSafeParseResult<ClaimEpisode>;
}

/** Validate and narrow a raw value into a full DemoSnapshot. */
export function parseDemoSnapshot(raw: unknown): DemoSnapshot {
  return demoSnapshotSchema.parse(raw);
}

/** Non-throwing variant of {@link parseDemoSnapshot}. */
export function safeParseDemoSnapshot(
  raw: unknown,
): z.ZodSafeParseResult<DemoSnapshot> {
  return demoSnapshotSchema.safeParse(raw) as z.ZodSafeParseResult<DemoSnapshot>;
}
