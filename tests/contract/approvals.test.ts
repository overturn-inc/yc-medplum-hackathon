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
import { getDemoRuntime, getDemoViewModel } from "@/server/demo";

function tempStore(agentMode: "synthetic" | "bff" = "synthetic") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-demo-"));
  return new LocalEventStore({ dataDir, healthcareMode: "local", agentMode });
}

function scopeFor(store: LocalEventStore, episodeId: string): ClientApprovalScope {
  const episode = store.getEpisode(episodeId)!;
  expect(episode.proposal).toBeTruthy();
  return proposalApprovalFields(episode.proposal!);
}

/** Builds a closed-shape RunEventV1 exactly matching run-event.v1.json for the
 * handful of event_type variants exercised in these tests. */
function runEvent(
  runId: string,
  index: number,
  eventType: "run_activated" | "run_completed" | "run_failed_fatal" | "run_outcome_unknown",
) {
  const base = {
    contract_version: "v1" as const,
    event_id: `evt-${index}-${eventType}`,
    run_id: runId,
    attempt_id: null,
    origin: "server" as const,
    attempt_sequence: null,
    run_event_index: index,
    occurred_at: "2026-08-01T00:00:00.000Z",
  };
  switch (eventType) {
    case "run_activated":
      return {
        ...base,
        event_type: eventType,
        run_state: "active",
        needs_reconciliation: false,
        payload: { kind: "none" },
      };
    case "run_completed":
      return {
        ...base,
        event_type: eventType,
        run_state: "completed",
        needs_reconciliation: false,
        // BF contract: RunCompletedPayload.assistant_message is
        // { content: string } exactly, not a role/content-array shape.
        payload: { assistant_message: { content: "ok" } },
      };
    case "run_failed_fatal":
      return {
        ...base,
        event_type: eventType,
        run_state: "failed_fatal",
        needs_reconciliation: false,
        payload: { error_code: "FATAL" },
      };
    case "run_outcome_unknown":
      return {
        ...base,
        event_type: eventType,
        run_state: "outcome_unknown",
        needs_reconciliation: true,
        payload: { obligation_id: "obl-1" },
      };
  }
}

function sseFrame(event: unknown, id: number): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
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

  it("createProposal/decide submit_claim on verified-paid claim F is 400/409 and never mutates the episode (P0 action policy)", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const before = store.getEpisode("episode-claim-f")!;
    expect(before.adjudicationState).toBe("paid");

    let createError: unknown;
    try {
      await actions.createProposal("episode-claim-f", "submit_claim");
    } catch (error) {
      createError = error;
    }
    expect(createError).toBeInstanceOf(Error);
    expect([400, 409]).toContain((createError as { status: number }).status);

    const afterCreate = store.getEpisode("episode-claim-f")!;
    expect(afterCreate).toEqual(before);
    expect(afterCreate.adjudicationState).toBe("paid");
    expect(afterCreate.proposal).toBeNull();

    let decideError: unknown;
    try {
      await actions.decide({
        episodeId: "episode-claim-f",
        actionType: "submit_claim",
        decision: "allow_once",
        scope: {
          proposalId: "forged-proposal",
          episodeId: "episode-claim-f",
          actionType: "submit_claim",
          payloadDigest: "forged-digest",
          episodeRevision: before.revision,
          fingerprint: "forged-fingerprint",
        },
      });
    } catch (error) {
      decideError = error;
    }
    expect(decideError).toBeInstanceOf(Error);
    expect([400, 409]).toContain((decideError as { status: number }).status);

    const afterDecide = store.getEpisode("episode-claim-f")!;
    expect(afterDecide).toEqual(before);
    expect(afterDecide.adjudicationState).toBe("paid");
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
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
        const body = frames.map((event, i) => sseFrame(event, [1, 1, 2][i])).join("");
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
    // run_completed proves only that the model finished; it must never be
    // treated as a domain mutation receipt.
    expect(result.outcome).toBe("pending_verification");
    expect(result.message).toContain("run_completed proves model completion only");
    expect(result.receiptId).toBeUndefined();
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
        return new Response(sseFrame(event, 1), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
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
          return new Response(sseFrame(event, 1), {
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

  it("BFF rejects plain JSON (non-SSE) event stream responses", async () => {
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url) => {
        if (String(url).includes("/events")) {
          return new Response(JSON.stringify([runEvent("run_x", 1, "run_completed")]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    await expect(bff.consumeEvents("run_x")).rejects.toMatchObject({
      code: "BFF_INVALID_RESPONSE",
    });
  });

  it("BFF rejects a run event with unexpected top-level fields", async () => {
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url) => {
        if (String(url).includes("/events")) {
          const event = { ...runEvent("run_x", 1, "run_completed"), extra_field: "nope" };
          return new Response(sseFrame(event, 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    await expect(bff.consumeEvents("run_x")).rejects.toMatchObject({
      code: "BFF_INVALID_RESPONSE",
    });
  });

  it("BFF rejects a run_completed payload with the wrong assistant_message shape", async () => {
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url) => {
        if (String(url).includes("/events")) {
          const event = {
            ...runEvent("run_x", 1, "run_completed"),
            payload: {
              assistant_message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
            },
          };
          return new Response(sseFrame(event, 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    await expect(bff.consumeEvents("run_x")).rejects.toMatchObject({
      code: "BFF_INVALID_RESPONSE",
    });
  });

  it("BFF rejects an SSE id that does not match run_event_index", async () => {
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url) => {
        if (String(url).includes("/events")) {
          const event = runEvent("run_x", 2, "run_completed");
          return new Response(sseFrame(event, 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    await expect(bff.consumeEvents("run_x")).rejects.toMatchObject({
      code: "BFF_INVALID_RESPONSE",
    });
  });

  it("BFF rejects any event that arrives after a terminal run event", async () => {
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url) => {
        if (String(url).includes("/events")) {
          const body =
            sseFrame(runEvent("run_x", 1, "run_completed"), 1) +
            sseFrame(runEvent("run_x", 2, "run_activated"), 2);
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    await expect(bff.consumeEvents("run_x")).rejects.toMatchObject({
      code: "BFF_INVALID_RESPONSE",
    });
  });

  it("BFF bounds the SSE event buffer to a maximum count", async () => {
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url) => {
        if (String(url).includes("/events")) {
          let body = "";
          for (let i = 1; i <= 300; i += 1) {
            body += sseFrame(runEvent("run_x", i, "run_activated"), i);
          }
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    await expect(bff.consumeEvents("run_x")).rejects.toMatchObject({
      code: "BFF_INVALID_RESPONSE",
    });
  });

  it("BFF supports multi-line SSE data concatenation", async () => {
    const event = runEvent("run_x", 1, "run_completed");
    const json = JSON.stringify(event);
    // Split right after a comma: SSE reconstructs multi-line `data:` fields
    // by joining with "\n", and a newline immediately after a JSON comma is
    // insignificant whitespace, so the rejoined payload still parses.
    const splitAt = json.indexOf(",") + 1;
    const body = `id: 1\ndata: ${json.slice(0, splitAt)}\ndata: ${json.slice(splitAt)}\n\n`;
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url) => {
        if (String(url).includes("/events")) {
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    const events = await bff.consumeEvents("run_x");
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("run_completed");
  });

  it("BFF run_completed never yields a fabricated domain success receipt through ActionService", async () => {
    const store = tempStore();
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/v1/threads") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ thread_id: "thr_rc", active_run_id: null, latest_run_id: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("/runs") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            run_id: "run_rc",
            thread_id: "thr_rc",
            state: "active",
            client_request_id: body.client_request_id,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("/events")) {
        return new Response(sseFrame(runEvent("run_rc", 1, "run_completed"), 1), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("no", { status: 404 });
    };
    const bff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl,
    });
    const actions = new ActionService(store, bff);
    const result = await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope: scopeFor(store, "episode-encounter-a"),
    });
    expect("pendingVerification" in result && result.pendingVerification).toBe(true);
    expect(result.receiptId).toBeNull();
    expect(store.getEpisode("episode-encounter-a")!.submissionReceiptId).toBeNull();
    expect(JSON.stringify(result)).not.toContain("bff-receipt");
  });

  it("BFF-mode snapshot allows server-built proposals only with an independent synthetic executor", async () => {
    const bffStore = tempStore("bff");
    expect(bffStore.getSnapshot().agentMode).toBe("bff");

    const blocked = new ActionService(
      bffStore,
      createBffAgentAdapter({
        baseUrl: "https://bff.example/",
        apiKey: "k",
        fetchImpl: async () => new Response("no", { status: 404 }),
      }),
    );
    await expect(
      blocked.createProposal("episode-claim-c", "request_reprocessing"),
    ).rejects.toMatchObject({ status: 503, code: "BFF_PROPOSAL_BLOCKED" });

    const allowed = new ActionService(bffStore, createSyntheticAgentAdapter());
    const created = await allowed.createProposal(
      "episode-claim-c",
      "request_reprocessing",
    );
    expect(created.proposal.actionType).toBe("request_reprocessing");
    expect(created.proposal.id).toBeTruthy();

    // Deny then re-propose still works under bff snapshot + synthetic executor.
    await allowed.decide({
      episodeId: "episode-claim-c",
      actionType: "request_reprocessing",
      decision: "deny",
      scope: proposalApprovalFields(created.proposal),
    });
    const reproposed = await allowed.createProposal(
      "episode-claim-c",
      "request_reprocessing",
    );
    expect(reproposed.proposal.actionType).toBe("request_reprocessing");
    expect(bffStore.getEpisode("episode-claim-c")!.proposal?.id).toBe(
      reproposed.proposal.id,
    );
  });

  it("getDemoRuntime keeps BFF for chat and a synthetic ActionService executor when local+bff", async () => {
    const previousAgent = process.env.AGENT_MODE;
    const previousHealthcare = process.env.HEALTHCARE_MODE;
    const previousBase = process.env.BFF_BASE_URL;
    const previousKey = process.env.BFF_API_KEY;
    process.env.AGENT_MODE = "bff";
    process.env.HEALTHCARE_MODE = "local";
    process.env.BFF_BASE_URL = "https://bff.example/";
    process.env.BFF_API_KEY = "test-key";
    try {
      const store = tempStore("bff");
      const runtime = await getDemoRuntime(store);
      expect(runtime.config.agentMode).toBe("bff");
      expect(runtime.agent.mode).toBe("bff");
      expect(runtime.agent.classifyConversation).toBeTypeOf("function");
      // Action executor must be the independent synthetic connector.
      const created = await runtime.actions.createProposal(
        "episode-encounter-a",
        "submit_claim",
      );
      expect(created.proposal.actionType).toBe("submit_claim");
      const decided = await runtime.actions.decide({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        scope: proposalApprovalFields(created.proposal),
      });
      expect(decided.receiptId).toBe("receipt-submit-episode-encounter-a");
    } finally {
      if (previousAgent === undefined) delete process.env.AGENT_MODE;
      else process.env.AGENT_MODE = previousAgent;
      if (previousHealthcare === undefined) delete process.env.HEALTHCARE_MODE;
      else process.env.HEALTHCARE_MODE = previousHealthcare;
      if (previousBase === undefined) delete process.env.BFF_BASE_URL;
      else process.env.BFF_BASE_URL = previousBase;
      if (previousKey === undefined) delete process.env.BFF_API_KEY;
      else process.env.BFF_API_KEY = previousKey;
    }
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
      if (href.includes("/fhir/R4/PaymentReconciliation")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer token-abc",
        );
        return new Response(
          JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [] }),
          { status: 200 },
        );
      }
      if (href.includes("/fhir/R4/Patient")) {
        expect(href).not.toContain("PaymentReconciliation:patient");
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
                  context: {
                    related: [{ reference: "Encounter/enc-1" }],
                  },
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
    expect(snapshot.episodes[0]?.evidence).toHaveLength(1);

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

  it("Medplum never mixes evidence, payments, or tasks across two claims for the same patient", async () => {
    const fetchImpl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (href.includes("/fhir/R4/PaymentReconciliation")) {
        return new Response(
          JSON.stringify({
            resourceType: "Bundle",
            type: "searchset",
            entry: [
              {
                resource: {
                  resourceType: "PaymentReconciliation",
                  id: "payrec-1",
                  status: "active",
                  created: "2026-07-12T00:00:00Z",
                  paymentDate: "2026-07-11",
                  paymentAmount: { value: 100, currency: "USD" },
                  paymentIdentifier: { value: "CN-1" },
                  detail: [
                    {
                      type: { coding: [{ code: "payment" }] },
                      request: { reference: "Claim/claim-1" },
                      amount: { value: 100, currency: "USD" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.includes("/fhir/R4/Patient")) {
        return new Response(
          JSON.stringify({
            resourceType: "Bundle",
            type: "searchset",
            entry: [
              {
                resource: {
                  resourceType: "Patient",
                  id: "pt-1",
                  name: [{ text: "Shared Patient" }],
                },
              },
              {
                resource: {
                  resourceType: "Organization",
                  id: "payer-1",
                  name: "Payer One",
                },
              },
              {
                resource: {
                  resourceType: "Coverage",
                  id: "cov-1",
                  status: "active",
                  beneficiary: { reference: "Patient/pt-1" },
                  payor: [{ reference: "Organization/payer-1" }],
                },
              },
              {
                resource: {
                  resourceType: "Claim",
                  id: "claim-1",
                  status: "active",
                  patient: { reference: "Patient/pt-1" },
                  identifier: [{ value: "CN-1" }],
                  insurance: [
                    { sequence: 1, focal: true, coverage: { reference: "Coverage/cov-1" } },
                  ],
                  total: { value: 200, currency: "USD" },
                },
              },
              {
                resource: {
                  resourceType: "Claim",
                  id: "claim-2",
                  status: "active",
                  patient: { reference: "Patient/pt-1" },
                  identifier: [{ value: "CN-2" }],
                  insurance: [
                    { sequence: 1, focal: true, coverage: { reference: "Coverage/cov-1" } },
                  ],
                  total: { value: 300, currency: "USD" },
                },
              },
              {
                resource: {
                  resourceType: "DocumentReference",
                  id: "doc-835-claim-1",
                  status: "current",
                  subject: { reference: "Patient/pt-1" },
                  description: "raw 835 ERA",
                  context: { related: [{ reference: "Claim/claim-1" }] },
                  content: [{ attachment: { contentType: "application/json", data: "e30=" } }],
                },
              },
              {
                resource: {
                  resourceType: "DocumentReference",
                  id: "doc-posting-claim-1",
                  status: "current",
                  subject: { reference: "Patient/pt-1" },
                  description: "PMS posting receipt",
                  context: { related: [{ reference: "Claim/claim-1" }] },
                  content: [
                    {
                      attachment: {
                        contentType: "application/json",
                        // { controlNumber: "CN-1", postedAmount: 100 }
                        data: "eyJjb250cm9sTnVtYmVyIjoiQ04tMSIsInBvc3RlZEFtb3VudCI6MTAwfQ==",
                      },
                    },
                  ],
                },
              },
              {
                resource: {
                  resourceType: "Task",
                  id: "task-claim-1",
                  status: "in-progress",
                  intent: "order",
                  focus: { reference: "Claim/claim-1" },
                  for: { reference: "Patient/pt-1" },
                  owner: { display: "Claim 1 owner" },
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
      clientSecret: "secret",
      projectId: "project",
      fetchImpl,
    });
    const snapshot = await medplum.readSnapshot();
    const claim1 = snapshot.episodes.find((e) => e.claimId === "CLAIM-1")!;
    const claim2 = snapshot.episodes.find((e) => e.claimId === "CLAIM-2")!;
    expect(claim1).toBeTruthy();
    expect(claim2).toBeTruthy();

    // claim-1 has an exact remittance + posting DocumentReference and a
    // matching control number, so it is independently verified paid.
    expect(claim1.financial.paid).toBe(100);
    expect(claim1.adjudicationState).toBe("paid");
    expect(claim1.postingState).toBe("reconciled");
    expect(claim1.owner).toBe("Claim 1 owner");

    // claim-2 shares the same patient and coverage but has no payment,
    // evidence, or task of its own: none of claim-1's resources leak in.
    expect(claim2.financial.paid).toBeNull();
    expect(claim2.adjudicationState).not.toBe("paid");
    expect(claim2.postingState).toBe("unposted");
    expect(claim2.remittanceState).toBe("none");
    expect(claim2.owner).toBe("Connected queue");
    expect(
      claim2.evidence.some((e) => e.reference.includes("doc-835-claim-1") || e.reference.includes("doc-posting-claim-1")),
    ).toBe(false);
    expect(claim2.observations.some((o) => o.source === "remittance" || o.source === "posting")).toBe(
      false,
    );
  });

  it("Medplum rejects a PaymentReconciliation linked to a different claim", async () => {
    const fetchImpl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (href.includes("/fhir/R4/PaymentReconciliation")) {
        return new Response(
          JSON.stringify({
            resourceType: "Bundle",
            type: "searchset",
            entry: [
              {
                resource: {
                  resourceType: "PaymentReconciliation",
                  id: "payrec-other",
                  status: "active",
                  created: "2026-07-12T00:00:00Z",
                  paymentDate: "2026-07-11",
                  paymentAmount: { value: 999, currency: "USD" },
                  detail: [
                    {
                      type: { coding: [{ code: "payment" }] },
                      // References a claim other than the one under test.
                      request: { reference: "Claim/claim-other" },
                      amount: { value: 999, currency: "USD" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.includes("/fhir/R4/Patient")) {
        return new Response(
          JSON.stringify({
            resourceType: "Bundle",
            type: "searchset",
            entry: [
              {
                resource: {
                  resourceType: "Patient",
                  id: "pt-2",
                  name: [{ text: "Solo Patient" }],
                },
              },
              {
                resource: {
                  resourceType: "Claim",
                  id: "claim-under-test",
                  status: "active",
                  patient: { reference: "Patient/pt-2" },
                  total: { value: 150, currency: "USD" },
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
      clientSecret: "secret",
      projectId: "project",
      fetchImpl,
    });
    const snapshot = await medplum.readSnapshot();
    const episode = snapshot.episodes.find((e) => e.claimId === "CLAIM-UNDER-TEST")!;
    expect(episode).toBeTruthy();
    expect(episode.financial.paid).toBeNull();
    expect(episode.remittanceState).toBe("none");
    expect(episode.adjudicationState).not.toBe("paid");
  });

  it("Medplum parses PMS posting content from the DocumentReference itself, never copying the paid amount", async () => {
    // Builds a minimal single-claim bundle with a remittance (control number
    // CN-1, paid 100) and a posting DocumentReference whose OWN JSON content
    // (base64 in content[0].attachment.data) is the `postingContentBase64`
    // under test. `null` means no posting document at all.
    function fetchImplFor(postingContentBase64: string | null) {
      return async (url: string | URL) => {
        const href = String(url);
        if (href.includes("/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        }
        if (href.includes("/fhir/R4/PaymentReconciliation")) {
          return new Response(
            JSON.stringify({
              resourceType: "Bundle",
              type: "searchset",
              entry: [
                {
                  resource: {
                    resourceType: "PaymentReconciliation",
                    id: "payrec-posting-test",
                    status: "active",
                    created: "2026-07-12T00:00:00Z",
                    paymentAmount: { value: 100, currency: "USD" },
                    paymentIdentifier: { value: "CN-1" },
                    detail: [
                      {
                        type: { coding: [{ code: "payment" }] },
                        request: { reference: "Claim/claim-posting-test" },
                        amount: { value: 100, currency: "USD" },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes("/fhir/R4/Patient")) {
          return new Response(
            JSON.stringify({
              resourceType: "Bundle",
              type: "searchset",
              entry: [
                {
                  resource: {
                    resourceType: "Patient",
                    id: "pt-posting-test",
                    name: [{ text: "Posting Test Patient" }],
                  },
                },
                {
                  resource: {
                    resourceType: "Claim",
                    id: "claim-posting-test",
                    status: "active",
                    patient: { reference: "Patient/pt-posting-test" },
                    identifier: [{ value: "CN-1" }],
                    total: { value: 200, currency: "USD" },
                  },
                },
                {
                  resource: {
                    resourceType: "DocumentReference",
                    id: "doc-835-posting-test",
                    status: "current",
                    subject: { reference: "Patient/pt-posting-test" },
                    description: "raw 835 ERA",
                    context: { related: [{ reference: "Claim/claim-posting-test" }] },
                    content: [
                      { attachment: { contentType: "application/json", data: "e30=" } },
                    ],
                  },
                },
                ...(postingContentBase64
                  ? [
                      {
                        resource: {
                          resourceType: "DocumentReference",
                          id: "doc-posting-posting-test",
                          status: "current",
                          subject: { reference: "Patient/pt-posting-test" },
                          description: "PMS posting receipt",
                          context: {
                            related: [{ reference: "Claim/claim-posting-test" }],
                          },
                          content: [
                            {
                              attachment: {
                                contentType: "application/json",
                                data: postingContentBase64,
                              },
                            },
                          ],
                        },
                      },
                    ]
                  : []),
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("no", { status: 404 });
      };
    }

    async function readPostingTestEpisode(postingContentBase64: string | null) {
      const medplum = createMedplumHealthcareRepository({
        baseUrl: "https://api.medplum.example",
        clientId: "id",
        clientSecret: "secret",
        projectId: "project",
        fetchImpl: fetchImplFor(postingContentBase64),
      });
      const snapshot = await medplum.readSnapshot();
      return snapshot.episodes.find((e) => e.claimId === "CLAIM-POSTING-TEST")!;
    }

    // Empty posting JSON (`{}`): neither controlNumber nor postedAmount, so
    // the posting document is never accepted as posting proof.
    const emptyContent = await readPostingTestEpisode("e30=");
    expect(emptyContent.postingState).toBe("unposted");
    expect(emptyContent.financial.posted).toBeNull();
    expect(emptyContent.adjudicationState).not.toBe("paid");

    // Wrong control number: posting content claims a different claim's
    // control number, so it must not reconcile THIS claim.
    const wrongControl = await readPostingTestEpisode(
      "eyJjb250cm9sTnVtYmVyIjoiQ04tV1JPTkciLCJwb3N0ZWRBbW91bnQiOjEwMH0=",
    );
    expect(wrongControl.postingState).toBe("unposted");
    expect(wrongControl.financial.posted).toBeNull();
    expect(wrongControl.adjudicationState).not.toBe("paid");

    // Wrong posted amount: control number matches, but the posting
    // document's own postedAmount (999) differs from the paid amount (100).
    // The mapper must use the document's real postedAmount -- never copy
    // `paid` -- so this must fail the exact-amount-match verified-paid gate.
    const wrongAmount = await readPostingTestEpisode(
      "eyJjb250cm9sTnVtYmVyIjoiQ04tMSIsInBvc3RlZEFtb3VudCI6OTk5fQ==",
    );
    expect(wrongAmount.financial.posted).toBe(999);
    expect(wrongAmount.financial.posted).not.toBe(wrongAmount.financial.paid);
    expect(wrongAmount.adjudicationState).not.toBe("paid");

    // No posting document at all.
    const noPosting = await readPostingTestEpisode(null);
    expect(noPosting.postingState).toBe("unposted");
    expect(noPosting.financial.posted).toBeNull();
    expect(noPosting.adjudicationState).not.toBe("paid");

    // Correct control number and correct posted amount: only this
    // combination independently verifies paid.
    const correct = await readPostingTestEpisode(
      "eyJjb250cm9sTnVtYmVyIjoiQ04tMSIsInBvc3RlZEFtb3VudCI6MTAwfQ==",
    );
    expect(correct.postingState).toBe("reconciled");
    expect(correct.financial.posted).toBe(100);
    expect(correct.adjudicationState).toBe("paid");
  });

  it("Medplum omits coverage/task linkage when a claim doesn't specify its own insurance/focus, even if another claim for the same patient does", async () => {
    const fetchImpl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (href.includes("/fhir/R4/PaymentReconciliation")) {
        return new Response(
          JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [] }),
          { status: 200 },
        );
      }
      if (href.includes("/fhir/R4/Patient")) {
        return new Response(
          JSON.stringify({
            resourceType: "Bundle",
            type: "searchset",
            entry: [
              {
                resource: {
                  resourceType: "Patient",
                  id: "pt-scoping-test",
                  name: [{ text: "Scoping Test Patient" }],
                },
              },
              {
                resource: {
                  resourceType: "Organization",
                  id: "payer-scoping-test",
                  name: "Scoped Payer",
                },
              },
              {
                resource: {
                  resourceType: "Coverage",
                  id: "cov-scoping-test",
                  status: "active",
                  beneficiary: { reference: "Patient/pt-scoping-test" },
                  payor: [{ reference: "Organization/payer-scoping-test" }],
                },
              },
              {
                resource: {
                  resourceType: "Claim",
                  id: "claim-scoped",
                  status: "active",
                  patient: { reference: "Patient/pt-scoping-test" },
                  insurance: [
                    {
                      sequence: 1,
                      focal: true,
                      coverage: { reference: "Coverage/cov-scoping-test" },
                    },
                  ],
                  total: { value: 200, currency: "USD" },
                },
              },
              {
                resource: {
                  // Shares the same patient (and thus the same Coverage
                  // would be found by a patient-wide scan) but does NOT
                  // specify its own insurance.coverage link.
                  resourceType: "Claim",
                  id: "claim-unscoped",
                  status: "active",
                  patient: { reference: "Patient/pt-scoping-test" },
                  total: { value: 50, currency: "USD" },
                },
              },
              {
                resource: {
                  resourceType: "Task",
                  id: "task-claim-scoped",
                  status: "requested",
                  intent: "order",
                  focus: { reference: "Claim/claim-scoped" },
                  for: { reference: "Patient/pt-scoping-test" },
                  owner: { display: "Scoped owner" },
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
      clientSecret: "secret",
      projectId: "project",
      fetchImpl,
    });
    const snapshot = await medplum.readSnapshot();
    const scoped = snapshot.episodes.find((e) => e.claimId === "CLAIM-SCOPED")!;
    const unscoped = snapshot.episodes.find((e) => e.claimId === "CLAIM-UNSCOPED")!;

    // claim-scoped specifies its own coverage and its own task focus: both
    // link correctly.
    expect(scoped.coverageActive).toBe(true);
    expect(scoped.owner).toBe("Scoped owner");

    // claim-unscoped shares the same patient but specifies neither its own
    // insurance.coverage nor a focused Task: no patient-wide fallback may
    // attach claim-scoped's Coverage or Task to it.
    expect(unscoped.coverageActive).toBe(false);
    expect(unscoped.payerName).not.toBe("Scoped Payer");
    expect(unscoped.owner).toBe("Connected queue");
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

  it("BFF chat mode classifies via closed schema and fails visibly without synthetic fallback", async () => {
    const { createAgentChatService } = await import("@/server/agent-chat");
    const store = tempStore("bff");
    const actions = new ActionService(store, createSyntheticAgentAdapter());

    const goodBff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href.endsWith("v1/threads") && init?.method === "POST") {
          return new Response(JSON.stringify({ thread_id: "thr_chat_1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (href.includes("/runs") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              run_id: "run_chat_1",
              thread_id: "thr_chat_1",
              client_request_id: "cr-chat-1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("/events")) {
          const event = {
            contract_version: "v1",
            event_id: "evt-mrc-1",
            run_id: "run_chat_1",
            attempt_id: "att_1",
            origin: "runtime",
            attempt_sequence: 1,
            run_event_index: 1,
            event_type: "model_response_completed",
            occurred_at: "2026-08-01T00:00:00.000Z",
            run_state: "active",
            needs_reconciliation: false,
            payload: {
              model_call_id: "mc_1",
              assistant_content: JSON.stringify({
                intent: "reason",
                suggestedActionType: null,
              }),
            },
          };
          return new Response(sseFrame(event, 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });

    const chat = createAgentChatService(store, actions, goodBff);
    const ok = await chat.handleChat({
      episodeId: "episode-claim-d",
      message: "Is this a payer denial?",
      clientRequestId: "cr-chat-1",
    });
    expect(ok.assistantMessage.intent).toBe("reason");
    expect(ok.assistantMessage.content.toLowerCase()).toMatch(/clearinghouse|rejection|denial/);
    expect(ok.proposalCreated).toBe(false);

    const badBff = createBffAgentAdapter({
      baseUrl: "https://bff.example/",
      apiKey: "k",
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href.endsWith("v1/threads") && init?.method === "POST") {
          return new Response(JSON.stringify({ thread_id: "thr_bad" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (href.includes("/runs") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              run_id: "run_bad",
              thread_id: "thr_bad",
              client_request_id: "cr-bad",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("/events")) {
          // run_completed alone is not a conversational receipt.
          return new Response(sseFrame(runEvent("run_bad", 1, "run_completed"), 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    });

    const failingChat = createAgentChatService(store, actions, badBff);
    await expect(
      failingChat.handleChat({
        episodeId: "episode-claim-c",
        message: "Why was this denied?",
        clientRequestId: "cr-bad",
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
