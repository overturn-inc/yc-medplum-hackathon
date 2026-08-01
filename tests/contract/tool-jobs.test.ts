import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalEventStore } from "@/server/store";
import { ToolJobService } from "@/server/tool-jobs";
import {
  resetRateLimitWindowsForTests,
  resetToolJobLedgers,
} from "@/server/tool-job-ledger";
import type {
  AutomationJobPublic,
  AutomationSidecarClient,
} from "@/adapters/automation/sidecar";
import { AutomationSidecarError } from "@/adapters/automation/sidecar";
import type { ClaimEpisode } from "@/domain/types";

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-tool-jobs-"));
  return new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
}

/**
 * Bypasses domain action policy to place `episode-encounter-a` directly into
 * an arbitrary hero-flow state, so `ToolJobService`'s own stage gating (not
 * the upstream proposal/approval flow, exercised separately in
 * `hero-appeal.test.ts`) can be tested in isolation.
 */
async function forceEpisodeState(
  store: LocalEventStore,
  patch: Partial<ClaimEpisode>,
): Promise<void> {
  await store.withMutationLock(async () => {
    store.beginMutation();
    const current = store.getEpisode("episode-encounter-a")!;
    store.replaceEpisode({ ...current, ...patch, revision: current.revision + 1 });
    store.commit();
  });
}

/** Controllable sidecar for testing the running -> polled -> completed path and cancel. */
function createControllableSidecarClient(): AutomationSidecarClient & {
  jobs: Map<string, AutomationJobPublic>;
} {
  const jobs = new Map<string, AutomationJobPublic>();
  return {
    jobs,
    async createJob(input) {
      const id = `ctrl-${input.idempotencyKey}`;
      const existing = jobs.get(id);
      if (existing) return { job: existing, duplicate: true };
      const job: AutomationJobPublic = {
        id,
        action: input.action,
        status: "running",
        progress: [
          { seq: 0, at: new Date().toISOString(), phase: "queued", message: "Job queued" },
          { seq: 1, at: new Date().toISOString(), phase: "navigating", message: "Opening portal" },
        ],
        result: null,
        error: null,
        receipt: null,
        proofs: [],
      };
      jobs.set(id, job);
      return { job, duplicate: false };
    },
    async getJob(id) {
      const job = jobs.get(id);
      if (!job) throw new AutomationSidecarError("Job not found", 404, "not_found");
      return job;
    },
    async cancelJob(id) {
      const job = jobs.get(id);
      if (!job) throw new AutomationSidecarError("Job not found", 404, "not_found");
      job.status = "cancelled";
      job.progress = [
        ...job.progress,
        { seq: job.progress.length, at: new Date().toISOString(), phase: "cancelled", message: "Cancelled" },
      ];
      return job;
    },
    async getProof() {
      return { contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
    },
  };
}

/** Flips a controllable job from running to completed with a receipt, as the real sidecar would between polls. */
function completeControllableJob(
  sidecar: ReturnType<typeof createControllableSidecarClient>,
  jobId: string,
  action: AutomationJobPublic["action"],
) {
  const job = sidecar.jobs.get(jobId)!;
  job.status = "completed";
  job.progress = [
    ...job.progress,
    { seq: job.progress.length, at: new Date().toISOString(), phase: "completed", message: "Completed" },
  ];
  job.result = { denialReason: "Authorization required" };
  job.receipt = {
    id: `receipt-${jobId}`,
    confirmation: null,
    summary: "Northstar portal investigation returned authorization-required denial",
    evidenceReference: `ConnectorReceipt/${action}-episode-encounter-a`,
    facts: { denialReason: "Authorization required" },
    proofIds: [`proof-${jobId}`],
  };
  job.proofs = [{ proofId: `proof-${jobId}`, contentType: "image/png" }];
}

beforeEach(() => {
  resetToolJobLedgers();
  resetRateLimitWindowsForTests();
});

describe("ToolJobService.create -- fixture and stage gating", () => {
  it("rejects tool jobs for fixtures other than encounter-a", async () => {
    const store = tempStore();
    const service = new ToolJobService(store);
    await expect(
      service.create({ episodeId: "episode-claim-c", action: "investigate_claim" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects investigate_claim before hero stage accepted_overdue", async () => {
    const store = tempStore();
    const service = new ToolJobService(store);
    await expect(
      service.create({ episodeId: "episode-encounter-a", action: "investigate_claim" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects submit_appeal via the generic create() entry point (approval-gated only)", async () => {
    const store = tempStore();
    const service = new ToolJobService(store);
    await expect(
      service.create({ episodeId: "episode-encounter-a", action: "submit_appeal" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("ToolJobService.create -- mock sidecar completes synchronously", () => {
  it("investigate_claim persists a connector receipt and advances heroStage to portal_denied", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "accepted_overdue",
    });
    const service = new ToolJobService(store);
    const { job, duplicate } = await service.create({
      episodeId: "episode-encounter-a",
      action: "investigate_claim",
    });
    expect(duplicate).toBe(false);
    expect(job.status).toBe("completed");
    expect(job.connectorReceipt).not.toBeNull();
    expect(job.connectorReceipt!.summary).toContain("authorization-required");
    expect(job.connectorReceipt!.proofRefs.length).toBeGreaterThan(0);

    const episode = store.getEpisode("episode-encounter-a")!;
    expect(episode.portalInvestigationReceiptId).toBe(job.connectorReceipt!.id);
    expect(episode.adjudicationState).toBe("denied");
    expect(episode.resolutionState).toBe("investigating");
    expect(episode.heroStage).toBe("portal_denied");
    expect(episode.evidence.some((e) => e.reference === job.connectorReceipt!.evidenceReference)).toBe(
      true,
    );
    expect(
      store.getSnapshot().events.some((e) => e.type === "tool_job.completed"),
    ).toBe(true);
    expect(
      store
        .getSnapshot()
        .events.some(
          (e) => e.type === "hero.stage.advanced" && "toStage" in e && e.toStage === "portal_denied",
        ),
    ).toBe(true);
  });

  it("rejects investigate_claim once the hero stage has already moved past accepted_overdue", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "accepted_overdue",
    });
    const service = new ToolJobService(store);
    await service.create({ episodeId: "episode-encounter-a", action: "investigate_claim" });

    await expect(
      service.create({
        episodeId: "episode-encounter-a",
        action: "investigate_claim",
        idempotencyKey: "a-second-distinct-key",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("voice_session at portal_denied advances heroStage to voice_evidence_collected with transcript/facts", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "portal_denied",
    });
    const service = new ToolJobService(store);
    const { job } = await service.create({
      episodeId: "episode-encounter-a",
      action: "voice_session",
    });
    expect(job.status).toBe("completed");
    expect(typeof job.result?.transcript).toBe("string");
    expect(job.connectorReceipt!.facts?.reasonCode).toBe("CO-197");

    const episode = store.getEpisode("episode-encounter-a")!;
    expect(episode.voiceSessionReceiptId).toBe(job.connectorReceipt!.id);
    expect(episode.heroStage).toBe("voice_evidence_collected");
  });

  it("recheck_reprocessing requires an existing reprocessing receipt before it will run", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "reprocessing",
      reprocessingReceiptId: null,
    });
    const service = new ToolJobService(store);
    await expect(
      service.create({ episodeId: "episode-encounter-a", action: "recheck_reprocessing" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("recheck_reprocessing advances heroStage to denial_upheld once a reprocessing receipt exists", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "reprocessing",
      reprocessingReceiptId: "receipt-reprocessing-1",
    });
    const service = new ToolJobService(store);
    const { job } = await service.create({
      episodeId: "episode-encounter-a",
      action: "recheck_reprocessing",
    });
    expect(job.status).toBe("completed");

    const episode = store.getEpisode("episode-encounter-a")!;
    expect(episode.denialUpheldReceiptId).toBe(job.connectorReceipt!.id);
    expect(episode.adjudicationState).toBe("denied");
    expect(episode.resolutionState).toBe("approval_required");
    expect(episode.heroStage).toBe("denial_upheld");
  });
});

describe("ToolJobService -- poll/cancel against a controllable (async) sidecar", () => {
  it("is idempotent under an explicit idempotencyKey while the remote job is still running", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "accepted_overdue",
    });
    const sidecar = createControllableSidecarClient();
    const service = new ToolJobService(store, sidecar);
    const idempotencyKey = "fixed-investigate-key";

    const first = await service.create({
      episodeId: "episode-encounter-a",
      action: "investigate_claim",
      idempotencyKey,
    });
    expect(first.duplicate).toBe(false);
    expect(sidecar.jobs.size).toBe(1);

    const second = await service.create({
      episodeId: "episode-encounter-a",
      action: "investigate_claim",
      idempotencyKey,
    });
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    // No second remote job was ever created for the same idempotency key.
    expect(sidecar.jobs.size).toBe(1);
    expect(store.getEpisode("episode-encounter-a")!.portalInvestigationReceiptId).toBeFalsy();
  });

  it("poll() applies the episode mutation only once the remote job completes, never at create time", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "accepted_overdue",
    });
    const sidecar = createControllableSidecarClient();
    const service = new ToolJobService(store, sidecar);

    const created = await service.create({
      episodeId: "episode-encounter-a",
      action: "investigate_claim",
    });
    expect(created.job.status).toBe("running");
    expect(store.getEpisode("episode-encounter-a")!.portalInvestigationReceiptId).toBeFalsy();

    // Flip the remote job to completed between polls, as a real sidecar would.
    const remoteJobId = [...sidecar.jobs.keys()][0]!;
    completeControllableJob(sidecar, remoteJobId, "investigate_claim");

    const polled = await service.poll(created.job.id);
    expect(polled.status).toBe("completed");
    expect(polled.connectorReceipt).not.toBeNull();

    const episode = store.getEpisode("episode-encounter-a")!;
    expect(episode.portalInvestigationReceiptId).toBe(polled.connectorReceipt!.id);
    expect(episode.heroStage).toBe("portal_denied");
  });

  it("cancel() marks an active job cancelled without applying any episode mutation", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "accepted_overdue",
    });
    const sidecar = createControllableSidecarClient();
    const service = new ToolJobService(store, sidecar);

    const created = await service.create({
      episodeId: "episode-encounter-a",
      action: "investigate_claim",
    });
    expect(created.job.status).toBe("running");

    const cancelled = await service.cancel(created.job.id);
    expect(cancelled.status).toBe("cancelled");
    expect(store.getEpisode("episode-encounter-a")!.portalInvestigationReceiptId).toBeFalsy();
  });

  it("cancelActiveForReset clears active jobs so a later poll reports not-found", async () => {
    const store = tempStore();
    await forceEpisodeState(store, {
      claimId: "CLM-EA-1001",
      heroStage: "accepted_overdue",
    });
    const sidecar = createControllableSidecarClient();
    const service = new ToolJobService(store, sidecar);

    const created = await service.create({
      episodeId: "episode-encounter-a",
      action: "investigate_claim",
    });
    expect(created.job.status).toBe("running");

    await service.cancelActiveForReset();
    await expect(service.poll(created.job.id)).rejects.toMatchObject({ status: 404 });
  });
});
