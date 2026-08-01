/**
 * In-process and D1-ready tool-job ledger with revision fencing, ordered
 * progress, connector receipts, and rate limits that survive session reset.
 */
import { createHash, randomUUID } from "node:crypto";
import { getDemoClock } from "@/domain/clock";
import {
  ACTIVE_TOOL_JOB_STATUSES,
  connectorReceiptSchema,
  isTerminalToolJobStatus,
  toolJobRecordSchema,
  type ConnectorReceipt,
  type ToolJobAction,
  type ToolJobPhase,
  type ToolJobProgressEvent,
  type ToolJobRecord,
  type ToolJobStatus,
} from "@/domain/tool-jobs";

export class ToolJobRevisionError extends Error {
  readonly status = 409;
  readonly code = "STALE_REVISION";
  constructor(message: string) {
    super(message);
    this.name = "ToolJobRevisionError";
  }
}

export class ToolJobRateLimitError extends Error {
  readonly status = 429;
  readonly code = "RATE_LIMITED";
  constructor(message: string) {
    super(message);
    this.name = "ToolJobRateLimitError";
  }
}

export class ToolJobCancelError extends Error {
  readonly status = 409;
  readonly code = "CANCEL_INCOMPLETE";
  constructor(message: string) {
    super(message);
    this.name = "ToolJobCancelError";
  }
}

type RateLimitConfig = {
  sessionLimit: number;
  globalLimit: number;
  windowMs: number;
};

const DEFAULT_RATE_LIMITS: Record<ToolJobAction | "eligibility", RateLimitConfig> = {
  investigate_claim: { sessionLimit: 6, globalLimit: 60, windowMs: 60_000 },
  recheck_reprocessing: { sessionLimit: 6, globalLimit: 60, windowMs: 60_000 },
  submit_appeal: { sessionLimit: 4, globalLimit: 40, windowMs: 60_000 },
  voice_session: { sessionLimit: 4, globalLimit: 40, windowMs: 60_000 },
  eligibility: { sessionLimit: 8, globalLimit: 80, windowMs: 60_000 },
};

type GlobalToolJobState = {
  __harborviewToolJobLedger?: Map<string, SessionToolJobLedger>;
  __harborviewRateLimits?: Map<string, { windowStart: number; count: number }>;
};

function globalLedgers(): Map<string, SessionToolJobLedger> {
  const g = globalThis as unknown as GlobalToolJobState;
  if (!g.__harborviewToolJobLedger) {
    g.__harborviewToolJobLedger = new Map();
  }
  return g.__harborviewToolJobLedger;
}

function globalRateLimits(): Map<string, { windowStart: number; count: number }> {
  const g = globalThis as unknown as GlobalToolJobState;
  if (!g.__harborviewRateLimits) {
    g.__harborviewRateLimits = new Map();
  }
  return g.__harborviewRateLimits;
}

function windowFloor(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export function consumeRateLimit(
  scope: string,
  limit: number,
  windowMs: number,
  nowMs = Date.now(),
): void {
  const floors = globalRateLimits();
  const start = windowFloor(nowMs, windowMs);
  const key = `${scope}:${start}`;
  const current = floors.get(key) ?? { windowStart: start, count: 0 };
  if (current.windowStart !== start) {
    current.windowStart = start;
    current.count = 0;
  }
  if (current.count >= limit) {
    throw new ToolJobRateLimitError(`Rate limit exceeded for ${scope}`);
  }
  current.count += 1;
  floors.set(key, current);
}

export function assertActionRateLimit(
  action: ToolJobAction | "eligibility",
  sessionId: string,
): void {
  const config = DEFAULT_RATE_LIMITS[action];
  consumeRateLimit(`session:${sessionId}:${action}`, config.sessionLimit, config.windowMs);
  consumeRateLimit(`global:${action}`, config.globalLimit, config.windowMs);
}

export class SessionToolJobLedger {
  private jobs = new Map<string, ToolJobRecord>();
  private byIdempotency = new Map<string, string>();
  private receipts = new Map<string, ConnectorReceipt>();
  private proofBytes = new Map<string, { contentType: string; bytes: Uint8Array }>();

  constructor(readonly sessionId: string) {}

  listActive(): ToolJobRecord[] {
    return [...this.jobs.values()].filter((job) =>
      ACTIVE_TOOL_JOB_STATUSES.has(job.status),
    );
  }

  get(jobId: string): ToolJobRecord | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  getByIdempotency(key: string): ToolJobRecord | undefined {
    const id = this.byIdempotency.get(key);
    return id ? this.get(id) : undefined;
  }

  getReceipt(receiptId: string): ConnectorReceipt | undefined {
    const receipt = this.receipts.get(receiptId);
    return receipt ? structuredClone(receipt) : undefined;
  }

  createReserved(input: {
    sessionRevision: number;
    episodeId: string;
    episodeRevision: number;
    action: ToolJobAction;
    idempotencyKey: string;
  }): ToolJobRecord {
    const existing = this.getByIdempotency(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    assertActionRateLimit(input.action, this.sessionId);
    const now = getDemoClock();
    const id = `job-${createHash("sha256")
      .update(`${this.sessionId}:${input.idempotencyKey}`)
      .digest("hex")
      .slice(0, 20)}`;
    const queued: ToolJobProgressEvent = {
      id: `${id}-evt-0`,
      seq: 0,
      at: now,
      phase: "queued",
      message: "Job queued",
    };
    const job: ToolJobRecord = {
      id,
      sessionId: this.sessionId,
      sessionRevision: input.sessionRevision,
      episodeId: input.episodeId,
      episodeRevision: input.episodeRevision,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      progress: [queued],
      result: null,
      error: null,
      connectorReceipt: null,
      proofRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    toolJobRecordSchema.parse(job);
    this.jobs.set(id, job);
    this.byIdempotency.set(input.idempotencyKey, id);
    return structuredClone(job);
  }

  assertFresh(job: ToolJobRecord, sessionRevision: number, episodeRevision: number): void {
    if (job.sessionRevision !== sessionRevision) {
      throw new ToolJobRevisionError(
        "Tool job result rejected: session revision changed (reset or stale)",
      );
    }
    if (job.episodeRevision !== episodeRevision) {
      throw new ToolJobRevisionError(
        "Tool job result rejected: episode revision changed",
      );
    }
  }

  appendProgress(
    jobId: string,
    phase: ToolJobPhase,
    message: string,
    proofRef?: string,
  ): ToolJobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown tool job ${jobId}`);
    if (isTerminalToolJobStatus(job.status)) {
      return structuredClone(job);
    }
    const seq = job.progress.length;
    const event: ToolJobProgressEvent = {
      id: `${jobId}-evt-${seq}`,
      seq,
      at: getDemoClock(),
      phase,
      message,
      ...(proofRef ? { proofRef } : {}),
    };
    job.progress = [...job.progress, event];
    if (proofRef) {
      job.proofRefs = [...job.proofRefs, proofRef];
    }
    if (phase === "queued") job.status = "queued";
    else if (phase === "cancelled") job.status = "cancelled";
    else if (phase === "failed") job.status = "failed_safe";
    else if (phase === "completed") job.status = "pending_verification";
    else if (job.status === "queued" || job.status === "reserved") job.status = "running";
    job.updatedAt = event.at;
    this.jobs.set(jobId, job);
    return structuredClone(job);
  }

  storeProof(proofId: string, contentType: string, bytes: Uint8Array): void {
    this.proofBytes.set(proofId, { contentType, bytes });
  }

  getProof(proofId: string): { contentType: string; bytes: Uint8Array } | undefined {
    return this.proofBytes.get(proofId);
  }

  finalize(
    jobId: string,
    input: {
      status: Extract<
        ToolJobStatus,
        "running" | "completed" | "failed_safe" | "pending_verification" | "cancelled"
      >;
      result?: Record<string, unknown> | null;
      error?: { code: string; message: string } | null;
      receipt?: ConnectorReceipt | null;
    },
  ): ToolJobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown tool job ${jobId}`);
    if (isTerminalToolJobStatus(job.status) && job.status === input.status) {
      return structuredClone(job);
    }
    if (input.receipt) {
      connectorReceiptSchema.parse(input.receipt);
      this.receipts.set(input.receipt.id, input.receipt);
    }
    job.status = input.status;
    job.result = input.result ?? job.result;
    job.error = input.error ?? job.error;
    job.connectorReceipt = input.receipt ?? job.connectorReceipt;
    job.updatedAt = getDemoClock();
    this.jobs.set(jobId, job);
    return structuredClone(job);
  }

  /**
   * Cancel all active jobs. Returns cancelled ids. Throws ToolJobCancelError
   * if any job remains active after cancel attempt.
   */
  cancelAllActive(): string[] {
    const cancelled: string[] = [];
    for (const job of this.listActive()) {
      this.appendProgress(job.id, "cancelled", "Cancelled by session reset");
      this.finalize(job.id, {
        status: "cancelled",
        error: { code: "RESET_CANCELLED", message: "Session reset cancelled active job" },
      });
      cancelled.push(job.id);
    }
    const stillActive = this.listActive();
    if (stillActive.length > 0) {
      throw new ToolJobCancelError(
        `Unable to confirm cancellation of ${stillActive.length} active tool job(s)`,
      );
    }
    return cancelled;
  }

  /** Clear job ledger for a fresh session revision after successful cancel. */
  clearJobsForReset(): void {
    this.jobs.clear();
    this.byIdempotency.clear();
    this.receipts.clear();
    this.proofBytes.clear();
  }
}

export function getSessionToolJobLedger(sessionId: string): SessionToolJobLedger {
  const ledgers = globalLedgers();
  let ledger = ledgers.get(sessionId);
  if (!ledger) {
    ledger = new SessionToolJobLedger(sessionId);
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}

/** Test-only: drop all ledgers. Rate limits intentionally survive unless cleared. */
export function resetToolJobLedgers(): void {
  globalLedgers().clear();
}

export function resetRateLimitWindowsForTests(): void {
  globalRateLimits().clear();
}

export function newIdempotencyKey(parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 32);
}

export function newReceiptId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
