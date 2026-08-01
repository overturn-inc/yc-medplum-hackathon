/**
 * Tool-job domain: fixed-action browser/voice connector jobs with ordered
 * progress, revision fencing, and connector-receipt finalization.
 */
import { z } from "zod";

export const TOOL_JOB_ACTIONS = [
  "investigate_claim",
  "recheck_reprocessing",
  "submit_appeal",
  "voice_session",
] as const;

export type ToolJobAction = (typeof TOOL_JOB_ACTIONS)[number];

export const TOOL_JOB_STATUSES = [
  "reserved",
  "queued",
  "running",
  "pending_verification",
  "completed",
  "failed_safe",
  "cancelled",
] as const;

export type ToolJobStatus = (typeof TOOL_JOB_STATUSES)[number];

export const ACTIVE_TOOL_JOB_STATUSES: ReadonlySet<ToolJobStatus> = new Set([
  "reserved",
  "queued",
  "running",
  "pending_verification",
]);

export const TOOL_JOB_PHASES = [
  "queued",
  "contacting",
  "navigating",
  "authenticating",
  "typing",
  "reading",
  "grounding",
  "preparing",
  "transcribing",
  "speaking",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ToolJobPhase = (typeof TOOL_JOB_PHASES)[number];

export const toolJobActionSchema = z.enum(TOOL_JOB_ACTIONS);
export const toolJobStatusSchema = z.enum(TOOL_JOB_STATUSES);
export const toolJobPhaseSchema = z.enum(TOOL_JOB_PHASES);

export const toolJobProgressEventSchema = z
  .object({
    id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    phase: toolJobPhaseSchema,
    message: z.string().min(1),
    proofRef: z.string().min(1).optional(),
  })
  .strict();

export type ToolJobProgressEvent = z.infer<typeof toolJobProgressEventSchema>;

export const connectorReceiptSchema = z
  .object({
    id: z.string().min(1),
    jobId: z.string().min(1).nullable(),
    episodeId: z.string().min(1),
    action: toolJobActionSchema,
    provider: z.enum([
      "northstar-portal",
      "deepgram",
      "stedi-eligibility",
      "simulated-stedi-clearinghouse",
    ]),
    confirmation: z.string().nullable(),
    summary: z.string().min(1),
    evidenceReference: z.string().min(1),
    createdAt: z.string().min(1),
    facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    proofRefs: z.array(z.string()).optional(),
  })
  .strict();

export type ConnectorReceipt = z.infer<typeof connectorReceiptSchema>;

export const toolJobRecordSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    sessionRevision: z.number().int().positive(),
    episodeId: z.string().min(1),
    episodeRevision: z.number().int().nonnegative(),
    action: toolJobActionSchema,
    idempotencyKey: z.string().min(1),
    status: toolJobStatusSchema,
    progress: z.array(toolJobProgressEventSchema),
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .nullable(),
    connectorReceipt: connectorReceiptSchema.nullable(),
    proofRefs: z.array(z.string()),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type ToolJobRecord = z.infer<typeof toolJobRecordSchema>;

/** Public-safe job view: never includes storage paths or credentials. */
export function toPublicToolJob(job: ToolJobRecord) {
  return {
    id: job.id,
    episodeId: job.episodeId,
    action: job.action,
    status: job.status,
    progress: job.progress.map((event) => ({
      seq: event.seq,
      at: event.at,
      phase: event.phase,
      message: event.message,
      hasProof: Boolean(event.proofRef),
      proofId: event.proofRef ? event.id : undefined,
    })),
    result: job.result,
    error: job.error,
    connectorReceipt: job.connectorReceipt
      ? {
          id: job.connectorReceipt.id,
          action: job.connectorReceipt.action,
          provider: job.connectorReceipt.provider,
          confirmation: job.connectorReceipt.confirmation,
          summary: job.connectorReceipt.summary,
          evidenceReference: job.connectorReceipt.evidenceReference,
          createdAt: job.connectorReceipt.createdAt,
          facts: job.connectorReceipt.facts,
          proofCount: job.connectorReceipt.proofRefs?.length ?? 0,
          // Actual proof ids for `GET /api/tool-jobs/:id/proof/:proofId`.
          // Per-progress-event proof ids are never populated by either the
          // mock or real automation sidecar (see `services/automation-sidecar`),
          // so the receipt's proof list is the only reliable source.
          proofRefs: job.connectorReceipt.proofRefs ?? [],
        }
      : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export type PublicToolJob = ReturnType<typeof toPublicToolJob>;

export function isTerminalToolJobStatus(status: ToolJobStatus): boolean {
  return (
    status === "completed" ||
    status === "failed_safe" ||
    status === "cancelled"
  );
}
