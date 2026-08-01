import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { MossClient } from "@moss-dev/moss";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 1_000;
const EPISODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function loadConfig() {
  const secretFile = process.env.MOSS_SECRET_FILE;
  const fromFile = secretFile
    ? JSON.parse(readFileSync(secretFile, "utf8"))
    : {};
  const config = {
    projectId: fromFile.projectId || process.env.MOSS_PROJECT_ID,
    projectKey: fromFile.projectKey || process.env.MOSS_PROJECT_KEY,
    indexName: fromFile.indexName || process.env.MOSS_INDEX_NAME,
    apiKey: fromFile.apiKey || process.env.MOSS_SIDECAR_API_KEY,
  };
  for (const [name, value] of Object.entries(config)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Missing required Moss sidecar configuration: ${name}`);
    }
  }
  return config;
}

const config = loadConfig();
let clientPromise = null;

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

function authorized(request) {
  const header = request.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(config.apiKey);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseQuery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const episodeId = value.episodeId;
  const query = value.query;
  const requestedTopK = value.topK ?? 4;
  if (
    typeof episodeId !== "string" ||
    !EPISODE_ID_PATTERN.test(episodeId) ||
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.length > MAX_QUERY_LENGTH ||
    !Number.isInteger(requestedTopK)
  ) {
    return null;
  }
  return {
    episodeId,
    query: query.trim(),
    topK: Math.min(Math.max(requestedTopK, 1), 8),
  };
}

async function getClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const client = new MossClient(config.projectId, config.projectKey, {
      cachePath: process.env.MOSS_CACHE_PATH || "/moss-cache",
    });
    await client.loadIndex(config.indexName);
    return client;
  })().catch((error) => {
    clientPromise = null;
    throw error;
  });
  return clientPromise;
}

async function handleQuery(request, response) {
  if (!authorized(request)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  let input;
  try {
    input = parseQuery(await readJsonBody(request));
  } catch {
    input = null;
  }
  if (!input) {
    json(response, 400, { error: "invalid_request" });
    return;
  }

  const startedAt = performance.now();
  try {
    const client = await getClient();
    const queryStartedAt = performance.now();
    const result = await client.query(config.indexName, input.query, {
      topK: input.topK,
      filter: {
        field: "episodeId",
        condition: { $eq: input.episodeId },
      },
    });
    const mossSearchMs = performance.now() - queryStartedAt;
    const documents = (Array.isArray(result.docs) ? result.docs : [])
      .filter((doc) => doc?.metadata?.episodeId === input.episodeId)
      .slice(0, input.topK)
      .map((doc) => ({
        id: String(doc.id),
        title: String(doc.metadata?.title || doc.id),
        reference: String(doc.metadata?.sourceReference || "Unknown source"),
        documentType: String(doc.metadata?.documentType || "unknown"),
        excerpt:
          String(doc.text).length > 240
            ? `${String(doc.text).slice(0, 237)}...`
            : String(doc.text),
        score: Number(doc.score),
      }));

    json(response, 200, {
      provider: "moss",
      indexName: config.indexName,
      execution: "aws-local-sidecar",
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      mossSearchMs: Math.round(mossSearchMs * 10) / 10,
      synthetic: true,
      documents,
    });
    console.log(
      JSON.stringify({
        event: "moss_query",
        episodeId: input.episodeId,
        documentCount: documents.length,
        latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      }),
    );
  } catch {
    console.error(JSON.stringify({ event: "moss_query_failed" }));
    json(response, 503, { error: "retrieval_unavailable" });
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health/live") {
    json(response, 200, { status: "live" });
    return;
  }
  if (request.method === "GET" && request.url === "/health/ready") {
    try {
      await getClient();
      json(response, 200, { status: "ready" });
    } catch {
      json(response, 503, { status: "not_ready" });
    }
    return;
  }
  if (request.method === "POST" && request.url === "/query") {
    await handleQuery(request, response);
    return;
  }
  json(response, 404, { error: "not_found" });
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "moss_sidecar_listening", port: PORT }));
});

async function shutdown() {
  server.close();
  try {
    const client = await clientPromise;
    await client?.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
