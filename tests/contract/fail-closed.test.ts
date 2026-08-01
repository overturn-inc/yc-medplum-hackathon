import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalEventStore, StoreDegradedError } from "@/server/store";
import {
  createSessionRepository,
  resetSessionRegistry,
  type MemorySessionRepository,
} from "@/server/repository";
import { ActionService } from "@/server/actions";

function tempDataDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("fail-closed ledgers (P1)", () => {
  it("LocalEventStore degrades (never silently reseeds) on corrupt JSON, then reset quarantines and recovers", () => {
    const dataDir = tempDataDir("pms-failclosed-json-");
    const first = new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
    expect(first.getDegraded()).toBeNull();
    expect(first.getSnapshot().episodes).toHaveLength(7);

    fs.appendFileSync(path.join(dataDir, "events.ndjson"), "{not valid json\n");

    const reloaded = new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
    expect(reloaded.getDegraded()).toBeTruthy();
    expect(() => reloaded.getSnapshot()).toThrow(StoreDegradedError);
    // Fails closed: writes must be blocked too, not just reads.
    expect(() => reloaded.beginMutation()).toThrow(StoreDegradedError);

    reloaded.reset();
    expect(reloaded.getDegraded()).toBeNull();
    expect(reloaded.getSnapshot().episodes).toHaveLength(7);

    const files = fs.readdirSync(dataDir);
    expect(files.some((f) => f.includes("quarantine"))).toBe(true);
  });

  it("LocalEventStore degrades on a schema-invalid event, then reset quarantines and recovers", () => {
    const dataDir = tempDataDir("pms-failclosed-schema-");
    const first = new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
    expect(first.getSnapshot().episodes).toHaveLength(7);

    fs.appendFileSync(
      path.join(dataDir, "events.ndjson"),
      `${JSON.stringify({ type: "not.a.real.event", id: "bad-1" })}\n`,
    );

    const reloaded = new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
    expect(reloaded.getDegraded()).toBeTruthy();
    expect(() => reloaded.getSnapshot()).toThrow(StoreDegradedError);

    reloaded.reset();
    expect(reloaded.getDegraded()).toBeNull();
    expect(reloaded.getSnapshot().episodes).toHaveLength(7);

    const files = fs.readdirSync(dataDir);
    expect(files.some((f) => f.includes("quarantine"))).toBe(true);
  });

  it("LocalEventStore degrades when the ledger has events but no demo.session.reset boundary", () => {
    const dataDir = tempDataDir("pms-failclosed-noreset-");
    const first = new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
    first.getSnapshot();

    // Rewrite the ledger dropping every demo.session.reset event, simulating
    // a truncated/tampered ledger with no verifiable active-segment start.
    const eventsFile = path.join(dataDir, "events.ndjson");
    const lines = fs
      .readFileSync(eventsFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes('"demo.session.reset"'));
    fs.writeFileSync(eventsFile, `${lines.join("\n")}\n`);

    const reloaded = new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
    expect(reloaded.getDegraded()).toBeTruthy();
    expect(reloaded.getDegraded()?.reason).toMatch(/demo\.session\.reset/);
    expect(() => reloaded.getSnapshot()).toThrow(StoreDegradedError);

    reloaded.reset();
    expect(reloaded.getDegraded()).toBeNull();
    expect(reloaded.getSnapshot().episodes).toHaveLength(7);
  });

  it("MemorySessionRepository fails closed on a corrupt mirror instead of silently reseeding, then reset quarantines and recovers", async () => {
    const dataDir = tempDataDir("pms-failclosed-mirror-");
    const prevDataDir = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = dataDir;
    try {
      const sessionId = `fail-closed-mirror-${Math.random().toString(36).slice(2)}`;
      const first = createSessionRepository(sessionId);
      const actions = new ActionService(first);
      await actions.createProposal("episode-encounter-a", "submit_claim");
      const before = await first.getEpisode("episode-encounter-a");
      expect(before!.revision).toBeGreaterThan(1);

      const mirrorFile = path.join(dataDir, "sessions", sessionId, "events.ndjson");
      expect(fs.existsSync(mirrorFile)).toBe(true);
      fs.appendFileSync(mirrorFile, "{not valid json\n");

      // Force a fresh MemorySessionRepository instance so it must re-read
      // (and fail closed on) the now-corrupt mirror instead of reusing the
      // still-healthy in-memory copy.
      resetSessionRegistry();
      const reloaded = createSessionRepository(sessionId) as MemorySessionRepository;
      expect(reloaded.getDegraded()).toBeTruthy();
      // Must NOT have silently reseeded: revision must not have silently
      // reset to a fresh episode set while claiming success.
      expect(() => reloaded.getEpisode("episode-encounter-a")).toThrow(StoreDegradedError);

      await reloaded.reset();
      expect(reloaded.getDegraded()).toBeNull();
      const afterReset = await reloaded.getEpisode("episode-encounter-a");
      expect(afterReset!.revision).toBe(1);

      const files = fs.readdirSync(path.join(dataDir, "sessions", sessionId));
      expect(files.some((f) => f.includes("quarantine"))).toBe(true);
    } finally {
      if (prevDataDir === undefined) delete process.env.DEMO_DATA_DIR;
      else process.env.DEMO_DATA_DIR = prevDataDir;
      resetSessionRegistry();
    }
  });
});
