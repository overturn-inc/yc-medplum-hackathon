import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalEventStore } from "@/server/store";
import { ActionService } from "@/server/actions";
import { computeDashboardKpi } from "@/domain/projector";
import { createBffAgentAdapter } from "@/adapters/agent/bff";
import { createMedplumHealthcareRepository } from "@/adapters/healthcare/medplum";
import { createSyntheticAgentAdapter } from "@/adapters/agent/synthetic";
import { loadServerConfig } from "@/server/config";
import { proposalApprovalFields } from "@/domain/approval";
import type { ClientApprovalScope } from "@/domain/approval";
import { getDemoViewModel } from "@/server/demo";

function tempStore(agentMode: "synthetic" | "bff" = "synthetic") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-demo-"));
  return new LocalEventStore({ dataDir, healthcareMode: "local", agentMode });
}

function scopeFor(store: LocalEventStore, episodeId: string): ClientApprovalScope {
  const episode = store.getEpisode(episodeId)!;
  expect(episode.proposal).toBeTruthy();
  return proposalApprovalFields(episode.proposal!);
}

function runEvent(runId: string, index: number, eventType: string) {
  return {
    contract_version: "v1",
    event_id: `evt-${index}`,
    run_id: runId,
    attempt_id: null,
    origin: "server",
    attempt_sequence: null,
    run_event_index: index,
    event_type: eventType,
    occurred_at: "2026-08-01T00:00:00.000Z",
    run_state:
      eventType === "run_completed"
        ? "completed"
        : eventType === "run_failed_fatal"
          ? "failed_fatal"
          : "outcome_unknown",
    needs_reconciliation: eventType === "run_outcome_unknown",
    payload:
      eventType === "run_completed"
        ? { assistant_message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }
        : eventType === "run_failed_fatal"
          ? { error_code: "FATAL" }
          : { obligation_id: "obl-1" },
  };
}

describe("approval and adapter contracts (repair-2)", () => {
  it("proposal creation does not mutate transport or adjudication", () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const before = store.getEpisode("episode-encounter-a")!;
    const transport = before.transportState;
    const adjudication = before.adjudicationState;
    actions.createProposal("episode-encounter-a", "submit_claim");
    const after = store.getEpisode("episode-encounter-a")!;
    expect(after.transportState).toBe(transport);
    expect(after.adjudicationState).toBe(adjudication);
    expect(after.submissionReceiptId).toBeNull();
  });

  it("deny clears proposal and approval_required with no side effects", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const result = await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "deny",
      scope: scopeFor(store, "episode-encounter-a"),
    });
    expect("denied" in result && result.denied).toBe(true);
    const episode = store.getEpisode("episode-encounter-a")!;
    expect(episode.proposal).toBeNull();
    expect(episode.resolutionState).not.toBe("approval_required");
    expect(episode.claimId).toBeNull();
    expect(episode.submissionReceiptId).toBeNull();
    expect(episode.transportState).toBe("unsent");
    expect(
      store.getSnapshot().events.filter((e) => e.type === "claim.submitted"),
    ).toHaveLength(0);

    // Rehydration must not recreate the denied proposal.
    const reloaded = new LocalEventStore({
      dataDir: store.dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    expect(reloaded.getEpisode("episode-encounter-a")!.proposal).toBeNull();
  });

  it("identical scope retry returns receipt; missing or tampered scope returns 409", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const scope = scopeFor(store, "episode-encounter-a");
    const first = await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope,
    });
    expect(first.receiptId).toBeTruthy();

    const second = await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope,
    });
    expect("idempotent" in second && second.idempotent).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
    expect(
      store.getSnapshot().events.filter((e) => e.type === "claim.submitted"),
    ).toHaveLength(1);

    await expect(
      actions.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      actions.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope: { ...scope, fingerprint: "tampered" },
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      actions.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope: { ...scope, proposalId: "other" },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("stale scope before success returns 409 with no execution", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const scope = scopeFor(store, "episode-claim-c");
    await expect(
      actions.decide({
        episodeId: "episode-claim-c",
        actionType: "request_reprocessing",
        decision: "allow_once",
        scope: { ...scope, episodeRevision: 999 },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.getEpisode("episode-claim-c")!.reprocessingReceiptId).toBeNull();
  });

  it("pending_verification creates no success receipt", async () => {
    const store = tempStore();
    const actions = new ActionService(
      store,
      createSyntheticAgentAdapter({ outcome: "pending_verification" }),
    );
    const result = await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope: scopeFor(store, "episode-encounter-a"),
    });
    expect("pendingVerification" in result && result.pendingVerification).toBe(true);
    expect(result.receiptId).toBeNull();
    expect(store.getEpisode("episode-encounter-a")!.submissionReceiptId).toBeNull();
  });

  it("reprocessing materializes Provenance and AuditEvent", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const beforeKpi = computeDashboardKpi(store.getSnapshot().episodes);
    await actions.decide({
      episodeId: "episode-claim-c",
      actionType: "request_reprocessing",
      decision: "allow_once",
      scope: scopeFor(store, "episode-claim-c"),
    });
    const episode = store.getEpisode("episode-claim-c")!;
    expect(episode.fhirResources.some((r) => r.resourceType === "Provenance")).toBe(
      true,
    );
    expect(episode.fhirResources.some((r) => r.resourceType === "AuditEvent")).toBe(
      true,
    );
    const afterKpi = computeDashboardKpi(store.getSnapshot().episodes);
    expect(afterKpi.verifiedPaidMtd).toBe(beforeKpi.verifiedPaidMtd);
  });

  it("BFF uses CreateThread/CreateRun DTOs, event_type, per-run cursor, and pending ambiguity", async () => {
    const bodies: unknown[] = [];
    const lastEventIds: Array<string | null> = [];
    let eventCalls = 0;

    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-bff-contract-version")).toBe("v1");
      expect(headers.get("authorization")).toMatch(/^Bearer /);

      if (href.endsWith("/v1/readiness")) {
        return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
      }
      if (href.endsWith("/v1/threads") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        expect(Object.keys(body).sort()).toEqual(["client_request_id"]);
        return new Response(
          JSON.stringify({
            thread_id: "thr_1",
            active_run_id: null,
            latest_run_id: null,
            queued_run_count: 0,
            created_at: "2026-08-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("/runs") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        expect(Object.keys(body).sort()).toEqual(["client_request_id", "prompt"]);
        expect(typeof body.prompt).toBe("string");
        return new Response(
          JSON.stringify({
            run_id: "run_1",
            thread_id: "thr_1",
            state: "active",
            needs_reconciliation: false,
            client_request_id: body.client_request_id,
            context_snapshot_id: null,
            thread_run_number: 1,
            created_at: "2026-08-01T00:00:00.000Z",
            launch_status: null,
            next_retry_at: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("/events")) {
        eventCalls += 1;
        lastEventIds.push(headers.get("last-event-id"));
        const frames = [
          runEvent("run_1", 1, "run_activated"),
          runEvent("run_1", 1, "run_activated"),
          runEvent("run_1", 2, "run_completed"),
        ];
        const body = frames
          .map(
            (event) =>
              `id: ${event.run_event_index}\ndata: ${JSON.stringify(event)}\n`,
          )
          .join("\n");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("nope", { status: 404 });
    };

    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "secret-value",
      fetchImpl,
    });
    expect((await bff.probe!()).available).toBe(true);
    const result = await bff.executeApprovedAction({
      actionType: "request_reprocessing",
      episodeId: "episode-claim-c",
      idempotencyKey: "client-key-1",
      payloadDigest: "digest",
    });
    expect(result.outcome).toBe("success");
    expect(lastEventIds[0]).toBeNull();

    const resumed = await bff.consumeEvents("run_1", { lastEventId: 2 });
    expect(lastEventIds[1]).toBe("2");
    expect(resumed).toEqual([]);

    const listed = await bff.listEvents("2");
    expect(Array.isArray(listed)).toBe(true);

    // Cross-run cursor isolation: run_2 starts without run_1 cursor.
    const fetchRun2: typeof fetchImpl = async (url, init) => {
      const href = String(url);
      if (href.includes("/events")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("last-event-id")).toBeNull();
        const event = runEvent("run_2", 1, "run_completed");
        return new Response(
          `id: 1\ndata: ${JSON.stringify(event)}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return fetchImpl(url, init);
    };
    const bff2 = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "secret-value",
      fetchImpl: fetchRun2,
    });
    // Direct consume on fresh adapter run_2
    const run2Events = await bff2.consumeEvents("run_2");
    expect(run2Events[0]?.run_id).toBe("run_2");

    const ambiguous = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "secret-value",
      fetchImpl: async () => {
        throw new Error("Bearer secret-value connection reset");
      },
    });
    const pending = await ambiguous.executeApprovedAction({
      actionType: "submit_claim",
      episodeId: "x",
      idempotencyKey: "k-amb",
      payloadDigest: "d",
    });
    expect(pending.outcome).toBe("pending_verification");
    expect(pending.message).not.toContain("secret-value");

    const unknown = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "secret-value",
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href.endsWith("/v1/threads") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              thread_id: "thr_u",
              active_run_id: null,
              latest_run_id: null,
              queued_run_count: 0,
              created_at: "2026-08-01T00:00:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("/runs") && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              run_id: "run_u",
              thread_id: "thr_u",
              state: "outcome_unknown",
              needs_reconciliation: true,
              client_request_id: body.client_request_id,
              context_snapshot_id: null,
              thread_run_number: 1,
              created_at: "2026-08-01T00:00:00.000Z",
              launch_status: null,
              next_retry_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("/events")) {
          const event = runEvent("run_u", 1, "run_outcome_unknown");
          return new Response(`id: 1\ndata: ${JSON.stringify(event)}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    const unknownResult = await unknown.executeApprovedAction({
      actionType: "submit_claim",
      episodeId: "y",
      idempotencyKey: "k-unknown",
      payloadDigest: "d",
    });
    expect(unknownResult.outcome).toBe("pending_verification");
    expect(eventCalls).toBeGreaterThan(0);
  });

  it("Medplum maps Bundle-only episodes and view model never uses local seed", async () => {
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "token-abc", token_type: "Bearer" }),
          { status: 200 },
        );
      }
      if (href.includes("/fhir/R4/")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer token-abc",
        );
        return new Response(
          JSON.stringify({
            resourceType: "Bundle",
            type: "searchset",
            entry: [
              {
                resource: {
                  resourceType: "Patient",
                  id: "mapped-1",
                  name: [{ text: "Mapped Patient" }],
                },
              },
              {
                resource: {
                  resourceType: "Encounter",
                  id: "enc-1",
                  status: "finished",
                  subject: { reference: "Patient/mapped-1" },
                  period: { start: "2026-07-20T10:00:00Z" },
                },
              },
              {
                resource: {
                  resourceType: "ChargeItem",
                  id: "chg-1",
                  subject: { reference: "Patient/mapped-1" },
                  context: { reference: "Encounter/enc-1" },
                  code: {
                    coding: [{ code: "99213", display: "Office visit" }],
                  },
                  quantity: { value: 1 },
                  priceOverride: { value: 185 },
                },
              },
              {
                resource: {
                  resourceType: "DocumentReference",
                  id: "doc-277",
                  status: "current",
                  subject: { reference: "Patient/mapped-1" },
                  description: "raw 277CA",
                  content: [
                    {
                      attachment: {
                        contentType: "application/json",
                        data: Buffer.from("{}").toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 404 });
    };

    const medplum = createMedplumHealthcareRepository({
      baseUrl: "https://api.medplum.example",
      clientId: "id",
      clientSecret: "super-secret",
      projectId: "project",
      fetchImpl,
    });
    const snapshot = await medplum.readSnapshot();
    expect(snapshot.episodes).toHaveLength(1);
    expect(snapshot.episodes[0]?.patientName).toBe("Mapped Patient");
    expect(snapshot.episodes[0]?.id).toBe("episode-encounter-enc-1");
    expect(snapshot.episodes[0]?.fixtureKey).toBe("connected-encounter");
    expect(snapshot.episodes.some((e) => e.id === "episode-encounter-a")).toBe(
      false,
    );
    expect(snapshot.episodes[0]?.observations.every((o) => !o.synthetic)).toBe(
      true,
    );

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-medplum-vm-"));
    const store = new LocalEventStore({
      dataDir,
      healthcareMode: "medplum",
      agentMode: "synthetic",
    });
    process.env.HEALTHCARE_MODE = "medplum";
    process.env.MEDPLUM_BASE_URL = "https://api.medplum.example";
    process.env.MEDPLUM_CLIENT_ID = "id";
    process.env.MEDPLUM_CLIENT_SECRET = "super-secret";
    process.env.MEDPLUM_PROJECT_ID = "project";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const model = await getDemoViewModel(store);
      expect(model.ok).toBe(true);
      if (!model.ok) return;
      expect(model.dataSource).toBe("medplum");
      expect(model.episodes).toHaveLength(1);
      expect(model.episodes[0]?.patientName).toBe("Mapped Patient");
      expect(model.kpi.readyToSubmit).toBe(1);
      expect(
        model.episodes.some((e) => e.id.startsWith("episode-encounter-a")),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.HEALTHCARE_MODE;
      delete process.env.MEDPLUM_BASE_URL;
      delete process.env.MEDPLUM_CLIENT_ID;
      delete process.env.MEDPLUM_CLIENT_SECRET;
      delete process.env.MEDPLUM_PROJECT_ID;
    }
  });

  it("server config rejects missing connected credentials", () => {
    expect(() =>
      loadServerConfig({
        HEALTHCARE_MODE: "medplum",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/MEDPLUM/);
    expect(() =>
      loadServerConfig({
        AGENT_MODE: "bff",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/BFF/);
  });
});
