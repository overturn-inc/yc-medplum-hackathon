import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalEventStore, StoreDegradedError } from "@/server/store";
import { ActionService } from "@/server/actions";
import { computeDashboardKpi } from "@/domain/projector";
import { proposalApprovalFields } from "@/domain/approval";

describe("event replay and reset (A18 repair-2)", () => {
  it("reconstructs submit and reprocess from NDJSON after deleting snapshot.json", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-replay-"));
    const store1 = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    const actions = new ActionService(store1);
    const before = computeDashboardKpi(store1.getSnapshot().episodes);

    await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(
        store1.getEpisode("episode-encounter-a")!.proposal!,
      ),
    });
    await actions.decide({
      episodeId: "episode-claim-c",
      actionType: "request_reprocessing",
      decision: "allow_once",
      scope: proposalApprovalFields(
        store1.getEpisode("episode-claim-c")!.proposal!,
      ),
    });

    const mid = computeDashboardKpi(store1.getSnapshot().episodes);
    expect(mid.readyToSubmit).toBe(before.readyToSubmit - 1);
    expect(store1.getEpisode("episode-encounter-a")!.submissionReceiptId).toBeTruthy();
    expect(store1.getEpisode("episode-claim-c")!.reprocessingReceiptId).toBeTruthy();

    fs.unlinkSync(path.join(dataDir, "snapshot.json"));
    expect(fs.existsSync(path.join(dataDir, "events.ndjson"))).toBe(true);

    const store2 = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    const rebuilt = computeDashboardKpi(store2.getSnapshot().episodes);
    expect(rebuilt.readyToSubmit).toBe(mid.readyToSubmit);
    expect(store2.getEpisode("episode-encounter-a")!.submissionReceiptId).toBeTruthy();
    expect(store2.getEpisode("episode-claim-c")!.reprocessingReceiptId).toBeTruthy();
    expect(store2.getEpisode("episode-claim-c")!.adjudicationState).toBe("denied");
  });

  it("healthy reset preserves history and restores seed KPI", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-reset-"));
    const store = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    const actions = new ActionService(store);
    const before = computeDashboardKpi(store.getSnapshot().episodes);
    await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(
        store.getEpisode("episode-encounter-a")!.proposal!,
      ),
    });
    const historyBefore = store.readAppendOnlyHistory();
    store.reset();
    const after = computeDashboardKpi(store.getSnapshot().episodes);
    expect(after.readyToSubmit).toBe(before.readyToSubmit);
    const historyAfter = store.readAppendOnlyHistory();
    expect(historyAfter.length).toBeGreaterThan(historyBefore.length);
    expect(historyAfter.some((e) => e.type === "claim.submitted")).toBe(true);
    expect(historyAfter.some((e) => e.type === "demo.session.reset")).toBe(true);
  });

  it("corrupt NDJSON degrades; Reset quarantines and recovers for immediate and restarted reads", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-corrupt-"));
    const store = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    store.getSnapshot();
    fs.writeFileSync(
      path.join(dataDir, "events.ndjson"),
      "{not-json\n{\"type\":\"demo.session.reset\"}\n",
    );

    const broken = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    expect(broken.getDegraded()).toBeTruthy();
    expect(() => broken.getSnapshot()).toThrow(StoreDegradedError);

    const recovered = broken.reset();
    expect(recovered.degraded).toBeNull();
    expect(recovered.episodes).toHaveLength(7);
    expect(() => broken.getSnapshot()).not.toThrow();

    const quarantine = fs
      .readdirSync(dataDir)
      .filter((name) => name.includes(".corrupt-") && name.endsWith(".quarantine"));
    expect(quarantine.length).toBeGreaterThan(0);

    const restarted = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    expect(restarted.getDegraded()).toBeNull();
    expect(restarted.getSnapshot().episodes).toHaveLength(7);
  });
});
