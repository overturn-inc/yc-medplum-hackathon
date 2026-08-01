/**
 * Server-owned ToolJobService: validates episode state and action, calls the
 * automation sidecar, persists ordered progress and connector receipts, and
 * applies episode mutations only after a verified connector receipt.
 */
import { getDemoClock } from "@/domain/clock";
import { deriveHeroStage, type HeroStage } from "@/domain/hero";
import type { ClaimEpisode, DomainEvent, EvidenceItem } from "@/domain/types";
import type {
  ConnectorReceipt,
  ToolJobAction,
  ToolJobPhase,
} from "@/domain/tool-jobs";
import { toPublicToolJob } from "@/domain/tool-jobs";
import {
  AutomationSidecarError,
  createAutomationSidecarClient,
  createMockAutomationSidecarClient,
  type AutomationSidecarClient,
  type AutomationJobPublic,
} from "@/adapters/automation/sidecar";
import {
  getSessionToolJobLedger,
  newIdempotencyKey,
  newReceiptId,
  ToolJobCancelError,
  ToolJobRateLimitError,
  ToolJobRevisionError,
  type SessionToolJobLedger,
} from "@/server/tool-job-ledger";
import type { SessionRepository } from "@/server/repository";
import type { PublicToolJob, ToolJobRecord } from "@/domain/tool-jobs";

const HERO_ACTIONS: ReadonlySet<ToolJobAction> = new Set([
  "investigate_claim",
  "recheck_reprocessing",
  "submit_appeal",
  "voice_session",
]);

function requireHeroEpisode(episode: ClaimEpisode | undefined, episodeId: string): ClaimEpisode {
  if (!episode) {
    throw Object.assign(new Error("Episode not found"), { status: 404 });
  }
  if (episode.fixtureKey !== "encounter-a") {
    throw Object.assign(
      new Error("Tool jobs are limited to the guided hero claim (encounter-a)"),
      { status: 400 },
    );
  }
  return episode;
}

function assertActionAllowedForStage(episode: ClaimEpisode, action: ToolJobAction): void {
  const stage = deriveHeroStage(episode);
  const allowed: Record<ToolJobAction, HeroStage[]> = {
    investigate_claim: ["accepted_overdue"],
    voice_session: ["portal_denied"],
    recheck_reprocessing: ["reprocessing"],
    submit_appeal: ["appeal_ready", "denial_upheld"],
  };
  if (!allowed[action].includes(stage)) {
    throw Object.assign(
      new Error(`Action ${action} is not allowed at hero stage ${stage}`),
      { status: 409 },
    );
  }
  if (action === "investigate_claim" && episode.portalInvestigationReceiptId) {
    throw Object.assign(new Error("Portal investigation receipt already exists"), {
      status: 409,
    });
  }
  if (action === "voice_session" && episode.voiceSessionReceiptId) {
    throw Object.assign(new Error("Voice session receipt already exists"), { status: 409 });
  }
  if (action === "recheck_reprocessing" && episode.denialUpheldReceiptId) {
    throw Object.assign(new Error("Denial upheld receipt already exists"), { status: 409 });
  }
  if (action === "submit_appeal" && episode.appealReceiptId) {
    throw Object.assign(new Error("Appeal receipt already exists"), { status: 409 });
  }
  if (
    (action === "investigate_claim" || action === "voice_session" || action === "recheck_reprocessing") &&
    !episode.claimId
  ) {
    throw Object.assign(new Error("Hero claim must be submitted before portal/voice work"), {
      status: 409,
    });
  }
  if (action === "recheck_reprocessing" && !episode.reprocessingReceiptId) {
    throw Object.assign(new Error("Reprocessing receipt required before denial recheck"), {
      status: 409,
    });
  }
  if (
    action === "submit_appeal" &&
    (!episode.portalInvestigationReceiptId ||
      !episode.voiceSessionReceiptId ||
      !episode.denialUpheldReceiptId)
  ) {
    throw Object.assign(
      new Error("Appeal requires portal, voice, and denial-upheld connector receipts"),
      { status: 409 },
    );
  }
}

function mapRemotePhase(phase: string): ToolJobPhase {
  const known: ToolJobPhase[] = [
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
  ];
  return (known.includes(phase as ToolJobPhase) ? phase : "contacting") as ToolJobPhase;
}

function providerFor(action: ToolJobAction): ConnectorReceipt["provider"] {
  return action === "voice_session" ? "deepgram" : "northstar-portal";
}

function sanitizeReceiptFacts(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const facts = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/** Shared sidecar client selection: real client when configured, mock otherwise. */
export function defaultAutomationSidecarClient(): AutomationSidecarClient {
  return process.env.AUTOMATION_SIDECAR_URL && process.env.AUTOMATION_SIDECAR_API_KEY
    ? createAutomationSidecarClient({
        baseUrl: process.env.AUTOMATION_SIDECAR_URL,
        apiKey: process.env.AUTOMATION_SIDECAR_API_KEY,
      })
    : createMockAutomationSidecarClient();
}

/** Free function so both `ToolJobService` and `runApprovalGatedToolJob` build identical receipts. */
export function buildToolJobReceipt(
  action: ToolJobAction,
  episodeId: string,
  jobId: string,
  remote: AutomationJobPublic,
): ConnectorReceipt {
  const at = getDemoClock();
  const confirmation =
    remote.receipt?.confirmation ??
    (typeof remote.result?.confirmationNumber === "string"
      ? remote.result.confirmationNumber
      : null);
  const summary =
    remote.receipt?.summary ??
    (action === "voice_session"
      ? "Deepgram voice session completed over scripted synthetic payer audio; no phone dialed"
      : action === "submit_appeal"
        ? `Northstar appeal submitted${confirmation ? ` (${confirmation})` : ""}`
        : action === "recheck_reprocessing"
          ? "Northstar portal recheck confirmed denial upheld"
          : "Northstar portal investigation returned authorization-required denial");
  const facts = sanitizeReceiptFacts(remote.receipt?.facts ?? remote.result?.facts);
  return {
    id: remote.receipt?.id ?? newReceiptId(`receipt-${action}`),
    jobId,
    episodeId,
    action,
    provider: providerFor(action),
    confirmation,
    summary,
    evidenceReference:
      remote.receipt?.evidenceReference ?? `ConnectorReceipt/${action}-${episodeId}`,
    createdAt: at,
    facts,
    proofRefs: remote.receipt?.proofIds ?? remote.proofs?.map((p) => p.proofId) ?? [],
  };
}

/** Free function so both `ToolJobService` and `runApprovalGatedToolJob` sync progress identically. */
function syncLedgerFromRemote(
  ledger: SessionToolJobLedger,
  localJobId: string,
  remote: AutomationJobPublic,
): ToolJobRecord {
  let local = ledger.get(localJobId);
  if (!local) throw new Error(`Unknown local job ${localJobId}`);

  for (const event of remote.progress ?? []) {
    const already = local.progress.some(
      (p) => p.seq === event.seq || (p.phase === mapRemotePhase(event.phase) && p.message === event.message),
    );
    if (already) continue;
    local = ledger.appendProgress(
      localJobId,
      mapRemotePhase(event.phase),
      event.message,
      event.proofId,
    );
  }

  ledger.finalize(localJobId, {
    status:
      remote.status === "completed"
        ? "pending_verification"
        : remote.status === "failed_safe"
          ? "failed_safe"
          : remote.status === "cancelled"
            ? "cancelled"
            : remote.status === "pending_verification"
              ? "pending_verification"
              : local.status === "queued"
                ? "running"
                : (local.status as "running"),
    result: {
      ...(remote.result ?? {}),
      remoteJobId: remote.id,
    },
    error: remote.error
      ? {
          code: remote.error.code ?? "REMOTE_ERROR",
          message: remote.error.message ?? "Remote job failed",
        }
      : null,
  });
  return ledger.get(localJobId)!;
}

/**
 * Runs a hero tool-job action to a connector receipt WITHOUT ever touching
 * the session repository / episode. `ActionService.decide`'s `submit_appeal`
 * approval path calls this from inside its own `store.withMutationLock`
 * critical section: calling `ToolJobService.create()` there instead would
 * deadlock, because its episode-mutation path (`applyReceiptToEpisode`) also
 * acquires the same per-session mutation lock. The caller is responsible for
 * applying the returned receipt to the episode itself, inside its own
 * already-open mutation.
 */
export async function runApprovalGatedToolJob(input: {
  sessionId: string;
  sessionRevision: number;
  episode: ClaimEpisode;
  action: ToolJobAction;
  idempotencyKey: string;
  sidecar?: AutomationSidecarClient;
}): Promise<{
  publicJob: PublicToolJob;
  receipt: ConnectorReceipt | null;
  terminal: boolean;
}> {
  const ledger = getSessionToolJobLedger(input.sessionId);
  const sidecar = input.sidecar ?? defaultAutomationSidecarClient();

  let existing = ledger.getByIdempotency(input.idempotencyKey);
  if (existing) {
    const remoteJobId =
      typeof existing.result?.remoteJobId === "string"
        ? existing.result.remoteJobId
        : null;
    if (
      remoteJobId &&
      (existing.status === "queued" ||
        existing.status === "running" ||
        existing.status === "pending_verification")
    ) {
      try {
        const remote = await sidecar.getJob(remoteJobId);
        existing = syncLedgerFromRemote(ledger, existing.id, remote);
        if (remote.status === "completed") {
          const receipt = buildToolJobReceipt(
            input.action,
            input.episode.id,
            existing.id,
            remote,
          );
          existing = ledger.finalize(existing.id, {
            status: "completed",
            result: remote.result ?? null,
            receipt,
          });
        }
      } catch {
        // Keep the existing reservation. A connector read failure must never
        // trigger a second external submission.
      }
    }
    return {
      publicJob: toPublicToolJob(existing),
      receipt: existing.connectorReceipt,
      terminal:
        existing.status === "completed" ||
        existing.status === "failed_safe" ||
        existing.status === "cancelled",
    };
  }

  let local = ledger.createReserved({
    sessionRevision: input.sessionRevision,
    episodeId: input.episode.id,
    episodeRevision: input.episode.revision,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
  });

  let remote: AutomationJobPublic;
  try {
    const created = await sidecar.createJob({
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      episodeId: input.episode.id,
      claimId: input.episode.claimId ?? undefined,
      sessionRevision: input.sessionRevision,
      episodeRevision: input.episode.revision,
    });
    remote = created.job;
    ledger.finalize(local.id, { status: "running", result: { remoteJobId: remote.id } });
    local = syncLedgerFromRemote(ledger, local.id, remote);

    // Approval-gated appeal should normally finish in the same user action.
    // Poll the already-created remote job for a short bounded window. This
    // never creates a second job and preserves receipt-first idempotency.
    for (let attempt = 0; remote.status === "queued" || remote.status === "running"; attempt += 1) {
      if (attempt >= 20) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      remote = await sidecar.getJob(remote.id);
      local = syncLedgerFromRemote(ledger, local.id, remote);
    }
  } catch (error) {
    const message =
      error instanceof AutomationSidecarError ? error.message : "Failed to start automation job";
    ledger.appendProgress(local.id, "failed", message);
    local = ledger.finalize(local.id, {
      status: "failed_safe",
      error: { code: "START_FAILED", message },
    });
    return { publicJob: toPublicToolJob(local), receipt: null, terminal: true };
  }

  if (remote.status === "completed") {
    const receipt = buildToolJobReceipt(input.action, input.episode.id, local.id, remote);
    local = ledger.finalize(local.id, {
      status: "completed",
      result: remote.result ?? null,
      receipt,
    });
    return { publicJob: toPublicToolJob(local), receipt, terminal: true };
  }

  if (remote.status === "failed_safe" || remote.status === "cancelled") {
    return { publicJob: toPublicToolJob(local), receipt: null, terminal: true };
  }

  // Still queued/running/pending_verification: the sidecar has not confirmed
  // a receipt yet. The caller must not consume the approval; a later retry
  // with the same idempotencyKey resumes from the ledger above.
  return { publicJob: toPublicToolJob(local), receipt: null, terminal: false };
}

export class ToolJobService {
  private readonly ledger: SessionToolJobLedger;
  private readonly sidecar: AutomationSidecarClient;

  constructor(
    private readonly store: SessionRepository,
    sidecar?: AutomationSidecarClient,
  ) {
    this.ledger = getSessionToolJobLedger(store.sessionId);
    this.sidecar = sidecar ?? defaultAutomationSidecarClient();
  }

  async create(input: {
    episodeId: string;
    action: ToolJobAction;
    idempotencyKey?: string;
  }) {
    if (!HERO_ACTIONS.has(input.action)) {
      throw Object.assign(new Error(`Unknown tool job action: ${input.action}`), {
        status: 400,
      });
    }
    if (input.action === "submit_appeal") {
      // submit_appeal is a formal payer write and must only run after
      // one-time proposal + Allow once approval (see `ActionService.decide`
      // and `runApprovalGatedToolJob`); it is never directly creatable via
      // this generic job-creation entry point.
      throw Object.assign(
        new Error(
          "submit_appeal requires proposal + Allow once approval; use POST /api/approvals, not /api/tool-jobs",
        ),
        { status: 403 },
      );
    }

    const snapshot = await this.store.getSnapshot();
    const episode = requireHeroEpisode(
      await this.store.getEpisode(input.episodeId),
      input.episodeId,
    );
    assertActionAllowedForStage(episode, input.action);

    const idempotencyKey =
      input.idempotencyKey ??
      newIdempotencyKey([
        this.store.sessionId,
        snapshot.sessionRevision.toString(),
        episode.id,
        episode.revision.toString(),
        input.action,
      ]);

    const existing = this.ledger.getByIdempotency(idempotencyKey);
    if (existing) {
      return { job: toPublicToolJob(existing), duplicate: true };
    }

    let local = this.ledger.createReserved({
      sessionRevision: snapshot.sessionRevision,
      episodeId: episode.id,
      episodeRevision: episode.revision,
      action: input.action,
      idempotencyKey,
    });

    try {
      const remote = await this.sidecar.createJob({
        action: input.action,
        idempotencyKey,
        episodeId: episode.id,
        claimId: episode.claimId ?? undefined,
        sessionRevision: snapshot.sessionRevision,
        episodeRevision: episode.revision,
      });
      this.ledger.finalize(local.id, {
        status: "running",
        result: { remoteJobId: remote.job.id },
      });
      local = this.syncFromRemote(local.id, remote.job);
      if (
        remote.job.status === "completed" ||
        remote.job.status === "pending_verification" ||
        remote.job.status === "failed_safe"
      ) {
        await this.maybeFinalizeFromRemote(local.id, remote.job);
        local = this.ledger.get(local.id)!;
      }
      return { job: toPublicToolJob(local), duplicate: remote.duplicate };
    } catch (error) {
      if (error instanceof ToolJobRateLimitError) throw error;
      const message =
        error instanceof AutomationSidecarError
          ? error.message
          : "Failed to start automation job";
      const status =
        error instanceof AutomationSidecarError ? error.status : 503;
      this.ledger.appendProgress(local.id, "failed", message);
      this.ledger.finalize(local.id, {
        status: "failed_safe",
        error: { code: "START_FAILED", message },
      });
      throw Object.assign(new Error(message), { status });
    }
  }

  async poll(jobId: string) {
    const local = this.ledger.get(jobId);
    if (!local) {
      throw Object.assign(new Error("Tool job not found"), { status: 404 });
    }

    const snapshot = await this.store.getSnapshot();
    const episode = await this.store.getEpisode(local.episodeId);
    if (!episode) {
      throw Object.assign(new Error("Episode not found"), { status: 404 });
    }

    try {
      this.ledger.assertFresh(local, snapshot.sessionRevision, episode.revision);
    } catch (error) {
      if (error instanceof ToolJobRevisionError) {
        this.ledger.finalize(jobId, {
          status: "failed_safe",
          error: { code: error.code, message: error.message },
        });
        throw error;
      }
      throw error;
    }

    if (
      local.status === "queued" ||
      local.status === "running" ||
      local.status === "pending_verification"
    ) {
      const remoteJobId =
        typeof local.result?.remoteJobId === "string"
          ? local.result.remoteJobId
          : local.id;
      try {
        const remoteJob = await this.sidecar.getJob(remoteJobId);
        this.syncFromRemote(local.id, remoteJob);
        if (
          remoteJob.status === "completed" ||
          remoteJob.status === "pending_verification" ||
          remoteJob.status === "failed_safe" ||
          remoteJob.status === "cancelled"
        ) {
          await this.maybeFinalizeFromRemote(local.id, remoteJob);
        }
      } catch {
        // Keep last known progress; never invent completion on poll errors.
      }
    }

    return toPublicToolJob(this.ledger.get(jobId)!);
  }

  async cancel(jobId: string) {
    const local = this.ledger.get(jobId);
    if (!local) {
      throw Object.assign(new Error("Tool job not found"), { status: 404 });
    }
    try {
      await this.sidecar.cancelJob(local.id);
    } catch {
      // Still mark local cancelled when sidecar cancel fails after timeout budget.
    }
    this.ledger.appendProgress(jobId, "cancelled", "Cancelled by client");
    const job = this.ledger.finalize(jobId, {
      status: "cancelled",
      error: { code: "CANCELLED", message: "Cancelled by client" },
    });
    return toPublicToolJob(job);
  }

  async getProof(jobId: string, proofId: string) {
    const local = this.ledger.get(jobId);
    if (!local) {
      throw Object.assign(new Error("Tool job not found"), { status: 404 });
    }
    const cached = this.ledger.getProof(proofId);
    if (cached) return cached;
    const remote = await this.sidecar.getProof(local.id, proofId);
    this.ledger.storeProof(proofId, remote.contentType, remote.bytes);
    return remote;
  }

  /**
   * Cancel active jobs before session reset. Throws 409 if cancellation
   * cannot be confirmed.
   */
  async cancelActiveForReset(): Promise<string[]> {
    try {
      const cancelled = this.ledger.cancelAllActive();
      this.ledger.clearJobsForReset();
      return cancelled;
    } catch (error) {
      if (error instanceof ToolJobCancelError) throw error;
      throw error;
    }
  }

  private syncFromRemote(localJobId: string, remote: AutomationJobPublic) {
    return syncLedgerFromRemote(this.ledger, localJobId, remote);
  }

  private async maybeFinalizeFromRemote(localJobId: string, remote: AutomationJobPublic) {
    const local = this.ledger.get(localJobId);
    if (!local) return;

    if (remote.status === "failed_safe" || remote.status === "cancelled") {
      this.ledger.finalize(localJobId, {
        status: remote.status,
        error: {
          code: remote.error?.code ?? remote.status.toUpperCase(),
          message: remote.error?.message ?? remote.status,
        },
      });
      return;
    }

    if (remote.status !== "completed" && remote.status !== "pending_verification") {
      return;
    }

    if (remote.status === "pending_verification" && local.action === "submit_appeal") {
      this.ledger.finalize(localJobId, {
        status: "pending_verification",
        result: remote.result ?? null,
        error: {
          code: "PENDING_VERIFICATION",
          message: "Appeal submission requires manual verification of confirmation",
        },
      });
      return;
    }

    const snapshot = await this.store.getSnapshot();
    const episode = await this.store.getEpisode(local.episodeId);
    if (!episode) return;

    try {
      this.ledger.assertFresh(local, snapshot.sessionRevision, episode.revision);
    } catch (error) {
      if (error instanceof ToolJobRevisionError) {
        this.ledger.finalize(localJobId, {
          status: "failed_safe",
          error: { code: error.code, message: error.message },
        });
      }
      return;
    }

    const receipt = buildToolJobReceipt(local.action, local.episodeId, localJobId, remote);
    this.ledger.finalize(localJobId, {
      status: "completed",
      result: remote.result ?? null,
      receipt,
    });
    await this.applyReceiptToEpisode(local.action, episode, receipt, localJobId);
  }

  private async applyReceiptToEpisode(
    action: ToolJobAction,
    episode: ClaimEpisode,
    receipt: ConnectorReceipt,
    jobId: string,
  ) {
    await this.store.withMutationLock(async () => {
      await this.store.beginMutation();
      try {
        const current = await this.store.getEpisode(episode.id);
        if (!current) {
          await this.store.abortMutation();
          return;
        }
        // Re-check fencing inside the lock.
        const snapshot = await this.store.getSnapshot();
        const local = this.ledger.get(jobId);
        if (!local) {
          await this.store.abortMutation();
          return;
        }
        this.ledger.assertFresh(local, snapshot.sessionRevision, current.revision);

        const at = getDemoClock();
        const fromStage = deriveHeroStage(current);
        const evidence: EvidenceItem = {
          id: `ev-${receipt.id}`,
          title:
            action === "voice_session"
              ? "Deepgram voice session evidence"
              : action === "submit_appeal"
                ? "Northstar appeal confirmation"
                : action === "recheck_reprocessing"
                  ? "Northstar denial upheld recheck"
                  : "Northstar portal denial snapshot",
          kind: action === "voice_session" ? "note" : "portal_snapshot",
          reference: receipt.evidenceReference,
          summary: receipt.summary,
          synthetic: true,
          observedAt: at,
        };

        let next: ClaimEpisode = {
          ...current,
          evidence: [...current.evidence, evidence],
          activities: [
            ...current.activities,
            {
              id: `activity-${receipt.id}`,
              episodeId: current.id,
              at,
              kind: `tool_job.${action}`,
              summary: receipt.summary,
              synthetic: true,
            },
          ],
          revision: current.revision + 1,
          lastVerifiedAt: at,
        };

        let toStage: HeroStage = fromStage;
        if (action === "investigate_claim") {
          next = {
            ...next,
            portalInvestigationReceiptId: receipt.id,
            adjudicationState: "denied",
            resolutionState: "investigating",
            issue: "Portal denial: Authorization required (conflicts with on-file auth)",
            heroStage: "portal_denied",
          };
          toStage = "portal_denied";
        } else if (action === "voice_session") {
          next = {
            ...next,
            voiceSessionReceiptId: receipt.id,
            heroStage: "voice_evidence_collected",
            agentAction: "Propose reprocessing before appeal",
          };
          toStage = "voice_evidence_collected";
        } else if (action === "recheck_reprocessing") {
          next = {
            ...next,
            denialUpheldReceiptId: receipt.id,
            adjudicationState: "denied",
            resolutionState: "approval_required",
            heroStage: "denial_upheld",
            issue: "Denial upheld after reprocessing recheck",
            agentAction: "Prepare formal appeal",
          };
          toStage = "denial_upheld";
        } else if (action === "submit_appeal") {
          // Appeal finalization (artifact/provenance) is owned by ActionService
          // after Allow once; here we only attach the portal connector receipt
          // if ActionService already moved to appealed, or stash receipt id.
          next = {
            ...next,
            appealReceiptId: next.appealReceiptId ?? receipt.id,
            appealConfirmationNumber:
              next.appealConfirmationNumber ?? receipt.confirmation,
          };
          if (next.resolutionState === "appealed") {
            next = { ...next, heroStage: "appeal_submitted" };
            toStage = "appeal_submitted";
          }
        }

        this.store.replaceEpisode(next);
        const events: DomainEvent[] = [
          {
            type: "tool_job.completed",
            id: `event-tool-job-${receipt.id}`,
            at,
            episodeId: next.id,
            jobId,
            action,
            receiptId: receipt.id,
          },
        ];
        if (toStage !== fromStage) {
          events.push({
            type: "hero.stage.advanced",
            id: `event-hero-${receipt.id}`,
            at,
            episodeId: next.id,
            fromStage,
            toStage,
            receiptId: receipt.id,
          });
        }
        for (const event of events) this.store.appendEvent(event);
        await this.store.commit();
      } catch (error) {
        await this.store.abortMutation();
        throw error;
      }
    });
  }
}
