import { describe, expect, it } from "vitest";
import {
  connectorReceiptSchema,
  isTerminalToolJobStatus,
  toolJobRecordSchema,
  toPublicToolJob,
  type ToolJobRecord,
} from "@/domain/tool-jobs";

function baseJob(overrides: Partial<ToolJobRecord> = {}): ToolJobRecord {
  const job: ToolJobRecord = {
    id: "job-1",
    sessionId: "session-1",
    sessionRevision: 1,
    episodeId: "episode-encounter-a",
    episodeRevision: 1,
    action: "investigate_claim",
    idempotencyKey: "idem-key-1",
    status: "queued",
    progress: [
      { id: "job-1-evt-0", seq: 0, at: "2026-08-01T00:00:00.000Z", phase: "queued", message: "Job queued" },
    ],
    result: null,
    error: null,
    connectorReceipt: null,
    proofRefs: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
  toolJobRecordSchema.parse(job);
  return job;
}

describe("isTerminalToolJobStatus", () => {
  it("is true only for completed/failed_safe/cancelled", () => {
    expect(isTerminalToolJobStatus("completed")).toBe(true);
    expect(isTerminalToolJobStatus("failed_safe")).toBe(true);
    expect(isTerminalToolJobStatus("cancelled")).toBe(true);
    expect(isTerminalToolJobStatus("reserved")).toBe(false);
    expect(isTerminalToolJobStatus("queued")).toBe(false);
    expect(isTerminalToolJobStatus("running")).toBe(false);
    expect(isTerminalToolJobStatus("pending_verification")).toBe(false);
  });
});

describe("toPublicToolJob", () => {
  it("never leaks internal fields (sessionId, idempotencyKey, storage paths)", () => {
    const job = baseJob();
    const publicJob = toPublicToolJob(job);
    const serialized = JSON.stringify(publicJob);
    expect(serialized).not.toContain("session-1");
    expect(serialized).not.toContain("idem-key-1");
    expect(publicJob).not.toHaveProperty("sessionId");
    expect(publicJob).not.toHaveProperty("sessionRevision");
    expect(publicJob).not.toHaveProperty("episodeRevision");
    expect(publicJob).not.toHaveProperty("idempotencyKey");
  });

  it("derives progress hasProof/proofId only from events that carry a proofRef", () => {
    const job = baseJob({
      progress: [
        { id: "job-1-evt-0", seq: 0, at: "t0", phase: "queued", message: "Job queued" },
        {
          id: "job-1-evt-1",
          seq: 1,
          at: "t1",
          phase: "reading",
          message: "Reading claim status",
          proofRef: "proof-investigate_claim-1",
        },
      ],
    });
    const publicJob = toPublicToolJob(job);
    expect(publicJob.progress[0]!.hasProof).toBe(false);
    expect(publicJob.progress[0]!.proofId).toBeUndefined();
    expect(publicJob.progress[1]!.hasProof).toBe(true);
    // The event's own id is exposed as `proofId`, not the raw proofRef.
    expect(publicJob.progress[1]!.proofId).toBe("job-1-evt-1");
  });

  it("surfaces the connector receipt's proof ids and count for GET /api/tool-jobs/:id/proof/:proofId", () => {
    const job = baseJob({
      status: "completed",
      connectorReceipt: {
        id: "receipt-1",
        jobId: "job-1",
        episodeId: "episode-encounter-a",
        action: "investigate_claim",
        provider: "northstar-portal",
        confirmation: null,
        summary: "Portal investigation returned authorization-required denial",
        evidenceReference: "ConnectorReceipt/investigate_claim-episode-encounter-a",
        createdAt: "2026-08-01T00:00:00.000Z",
        facts: { denialReason: "Authorization required" },
        proofRefs: ["proof-investigate_claim-1"],
      },
    });
    const publicJob = toPublicToolJob(job);
    expect(publicJob.connectorReceipt).not.toBeNull();
    expect(publicJob.connectorReceipt!.proofCount).toBe(1);
    expect(publicJob.connectorReceipt!.proofRefs).toEqual(["proof-investigate_claim-1"]);
    expect(publicJob.connectorReceipt!.facts).toEqual({ denialReason: "Authorization required" });
  });

  it("reports an empty proof list (never undefined) when the receipt has none", () => {
    const job = baseJob({
      status: "completed",
      connectorReceipt: {
        id: "receipt-2",
        jobId: "job-1",
        episodeId: "episode-encounter-a",
        action: "voice_session",
        provider: "deepgram",
        confirmation: null,
        summary: "Deepgram voice session completed",
        evidenceReference: "ConnectorReceipt/voice_session-episode-encounter-a",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    });
    const publicJob = toPublicToolJob(job);
    expect(publicJob.connectorReceipt!.proofCount).toBe(0);
    expect(publicJob.connectorReceipt!.proofRefs).toEqual([]);
  });
});

describe("connectorReceiptSchema / toolJobRecordSchema", () => {
  it("rejects an unknown provider", () => {
    expect(() =>
      connectorReceiptSchema.parse({
        id: "receipt-1",
        jobId: "job-1",
        episodeId: "episode-encounter-a",
        action: "investigate_claim",
        provider: "some-other-portal",
        confirmation: null,
        summary: "x",
        evidenceReference: "ConnectorReceipt/x",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an unknown tool job action", () => {
    expect(() => baseJob({ action: "unknown_action" as never })).toThrow();
  });

  it("accepts every documented terminal and non-terminal status", () => {
    for (const status of [
      "reserved",
      "queued",
      "running",
      "pending_verification",
      "completed",
      "failed_safe",
      "cancelled",
    ] as const) {
      expect(() => baseJob({ status })).not.toThrow();
    }
  });
});
