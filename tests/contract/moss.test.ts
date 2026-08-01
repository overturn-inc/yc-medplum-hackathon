import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MossCloudRetrievalAdapter,
  MossRetrievalError,
  MossSidecarRetrievalAdapter,
} from "@/adapters/retrieval/moss";
import { buildMossDocuments, buildMossDocumentsV2 } from "@/adapters/retrieval/moss-documents";
import type { RetrievalAdapter } from "@/adapters/retrieval/types";
import { DEFAULT_DEMO_CLOCK } from "@/domain/clock";
import { createSeedEpisodes } from "@/domain/fixtures";
import { ActionService } from "@/server/actions";
import { createAgentChatService } from "@/server/agent-chat";
import { loadServerConfig } from "@/server/config";
import { LocalEventStore } from "@/server/store";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Moss retrieval contract", () => {
  it("authenticates server-side, caches the token, and drops cross-episode hits", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/auth")) {
        return response({ token: "short-lived-token", expiresIn: 300 }, 201);
      }
      return response({
        query: "authorization",
        indexName: "claims",
        timeTakenInMs: 4.2,
        docs: [
          {
            id: "wrong-claim",
            text: "A different claim",
            score: 0.99,
            metadata: {
              episodeId: "episode-claim-d",
              title: "Wrong claim",
              sourceReference: "DocumentReference/wrong",
              documentType: "evidence",
            },
          },
          {
            id: "claim-c-auth",
            text: "Authorization is not required for the synthetic service.",
            score: 0.97,
            metadata: {
              episodeId: "episode-claim-c",
              title: "Authorization not required",
              sourceReference: "DocumentReference/doc-auth-claim-c",
              documentType: "evidence:authorization",
            },
          },
        ],
      });
    });
    const moss = new MossCloudRetrievalAdapter({
      projectId: "project",
      projectKey: "server-key",
      indexName: "claims",
      authUrl: "https://moss.test/auth",
      queryUrl: "https://moss.test/query",
      fetchImpl,
    });

    const first = await moss.query({
      episodeId: "episode-claim-c",
      query: "authorization",
    });
    const second = await moss.query({
      episodeId: "episode-claim-c",
      query: "reprocessing",
    });

    expect(first.documents.map((doc) => doc.id)).toEqual(["claim-c-auth"]);
    expect(first.mossSearchMs).toBe(4.2);
    expect(second.documents).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/auth"))).toHaveLength(1);
  });

  it("never leaks upstream response bodies or credentials in errors", async () => {
    const moss = new MossCloudRetrievalAdapter({
      projectId: "project",
      projectKey: "super-secret-key",
      indexName: "claims",
      authUrl: "https://moss.test/auth",
      fetchImpl: async () => new Response("internal secret details", { status: 401 }),
    });
    await expect(
      moss.query({ episodeId: "episode-claim-c", query: "status" }),
    ).rejects.toEqual(expect.any(MossRetrievalError));
    await expect(
      moss.query({ episodeId: "episode-claim-c", query: "status" }),
    ).rejects.not.toThrow(/super-secret-key|internal secret details/);
  });

  it("calls the authenticated AWS sidecar without Moss project credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({
        provider: "moss",
        indexName: "claims",
        execution: "aws-local-sidecar",
        latencyMs: 12.5,
        mossSearchMs: 3.1,
        synthetic: true,
        documents: [
          {
            id: "claim-c-auth",
            title: "Authorization not required",
            reference: "DocumentReference/doc-auth-claim-c",
            documentType: "evidence:authorization",
            excerpt: "Authorization is not required.",
            score: 0.97,
          },
        ],
      }),
    );
    const moss = new MossSidecarRetrievalAdapter({
      endpoint: "https://bff.test/v1/moss/query",
      apiKey: "sidecar-secret",
      indexName: "claims",
      fetchImpl,
    });

    const result = await moss.query({
      episodeId: "episode-claim-c",
      query: "authorization",
      topK: 3,
    });

    expect(result.execution).toBe("aws-local-sidecar");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://bff.test/v1/moss/query",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sidecar-secret",
        }),
      }),
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      episodeId: "episode-claim-c",
      query: "authorization",
      topK: 3,
    });
  });

  it("requires complete server-only config in live mode", () => {
    expect(() =>
      loadServerConfig({ MOSS_MODE: "live" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/MOSS_INDEX_NAME/);
    expect(
      loadServerConfig({
        MOSS_MODE: "live",
        MOSS_PROJECT_ID: "project",
        MOSS_PROJECT_KEY: "key",
        MOSS_INDEX_NAME: "claims",
      } as unknown as NodeJS.ProcessEnv).mossMode,
    ).toBe("live");
  });

  it("requires only endpoint credentials for sidecar execution", () => {
    const config = loadServerConfig({
      MOSS_MODE: "live",
      MOSS_EXECUTION: "sidecar",
      MOSS_INDEX_NAME: "claims",
      MOSS_SIDECAR_URL: "https://bff.test/v1/moss/query",
      MOSS_SIDECAR_API_KEY: "sidecar-secret",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.mossExecution).toBe("sidecar");
    expect(config.mossProjectKey).toBeUndefined();
  });

  it("builds a synthetic corpus without names or member IDs", () => {
    const episodes = createSeedEpisodes(DEFAULT_DEMO_CLOCK);
    const documents = buildMossDocuments(episodes);
    const serialized = JSON.stringify(documents);
    expect(documents).toHaveLength(39);
    for (const episode of episodes) {
      expect(serialized).not.toContain(episode.patientName);
      if (episode.memberId) expect(serialized).not.toContain(episode.memberId);
    }
    expect(documents.every((doc) => doc.metadata.synthetic === "true")).toBe(true);
  });

  it("v2 corpus adds hero policy docs without regressing the v1 shape or leaking names/member IDs", () => {
    const episodes = createSeedEpisodes(DEFAULT_DEMO_CLOCK);
    const v1Documents = buildMossDocuments(episodes);
    const v2Documents = buildMossDocumentsV2(episodes);

    // v2 is strictly additive over v1 for the default fixture set.
    expect(v1Documents).toHaveLength(39);
    expect(v2Documents.length).toBeGreaterThan(v1Documents.length);

    const heroEpisode = episodes.find((e) => e.id === "episode-encounter-a")!;
    expect(heroEpisode.portalInvestigationReceiptId).toBeFalsy();
    expect(heroEpisode.voiceSessionReceiptId).toBeFalsy();

    // Appeal policy is always available for encounter-a; portal/voice policy
    // docs are gated on their durable receipt ids, absent in the seed fixture.
    expect(v2Documents.some((d) => d.id === "appeal-policy-episode-encounter-a")).toBe(true);
    expect(v2Documents.some((d) => d.id === "portal-policy-episode-encounter-a")).toBe(false);
    expect(v2Documents.some((d) => d.id === "voice-policy-episode-encounter-a")).toBe(false);

    // Once the receipts exist on the episode, the gated docs appear too.
    const withReceipts = episodes.map((e) =>
      e.id === "episode-encounter-a"
        ? { ...e, portalInvestigationReceiptId: "receipt-portal-1", voiceSessionReceiptId: "receipt-voice-1" }
        : e,
    );
    const v2WithReceipts = buildMossDocumentsV2(withReceipts);
    expect(v2WithReceipts.some((d) => d.id === "portal-policy-episode-encounter-a")).toBe(true);
    expect(v2WithReceipts.some((d) => d.id === "voice-policy-episode-encounter-a")).toBe(true);

    const serialized = JSON.stringify(v2WithReceipts);
    for (const episode of episodes) {
      expect(serialized).not.toContain(episode.patientName);
      if (episode.memberId) expect(serialized).not.toContain(episode.memberId);
    }
    expect(v2Documents.every((doc) => doc.metadata.synthetic === "true")).toBe(true);
  });
});

describe("Agent chat uses Moss as scoped evidence ranking", () => {
  it("returns retrieval proof and ranks a retrieved Claim C citation first", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-moss-chat-"));
    const store = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    const retrieval: RetrievalAdapter = {
      provider: "moss",
      async query() {
        return {
          provider: "moss",
          indexName: "claims",
          execution: "cloud-semantic-search",
          latencyMs: 8.1,
          mossSearchMs: 2.4,
          synthetic: true,
          documents: [
            {
              id: "auth",
              title: "Authorization not required",
              reference: "DocumentReference/doc-auth-claim-c",
              documentType: "evidence:authorization",
              excerpt: "Authorization is not required.",
              score: 0.98,
            },
          ],
        };
      },
    };

    const result = await createAgentChatService(
      store,
      new ActionService(store),
      null,
      retrieval,
    ).handleChat({
      episodeId: "episode-claim-c",
      message: "What evidence supports reprocessing?",
      clientRequestId: "moss-chat-1",
    });

    expect(result.retrieval?.provider).toBe("moss");
    expect(result.assistantMessage.citations[0]?.reference).toBe(
      "DocumentReference/doc-auth-claim-c",
    );
    expect(result.proposalCreated).toBe(false);
  });

  it("keeps a grounded read available when Moss is down", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-moss-down-"));
    const store = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    const retrieval: RetrievalAdapter = {
      provider: "moss",
      async query() {
        throw new Error("key=never-return-this");
      },
    };
    const result = await createAgentChatService(
      store,
      new ActionService(store),
      null,
      retrieval,
    ).handleChat({
      episodeId: "episode-claim-c",
      message: "Why was this denied?",
      clientRequestId: "moss-chat-2",
    });
    expect(result.retrieval).toBeNull();
    expect(result.retrievalError).toBe("Moss retrieval is temporarily unavailable");
    expect(result.assistantMessage.content).toContain("authorization evidence");
    expect(JSON.stringify(result)).not.toContain("never-return-this");
  });
});
