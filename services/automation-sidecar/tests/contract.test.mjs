import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "server.mjs");
const runId = randomUUID();

const PORT = 8095;
const API_KEY = "contract-test-key";
const BASE_URL = `http://127.0.0.1:${PORT}`;

let child;

before(async () => {
  child = spawn(
    process.execPath,
    [serverPath],
    {
      cwd: path.join(here, ".."),
      env: {
        ...process.env,
        PORT: String(PORT),
        AUTOMATION_SIDECAR_API_KEY: API_KEY,
        PROOF_DIR: path.join(os.tmpdir(), `automation-sidecar-proof-test-${runId}`),
        AUTOMATION_VOICE_MODE: "mock",
        AUTOMATION_QUEUE_DELAY_MS: "200",
        AUTOMATION_JOB_TIMEOUT_MS: "20000",
        PORTAL_STATE_FILE: path.join(os.tmpdir(), `automation-sidecar-portal-state-test-${runId}.json`),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in time")), 15000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("automation_sidecar_listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
});

after(async () => {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
});

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...extra };
}

async function createJob(body) {
  const response = await fetch(`${BASE_URL}/v1/jobs`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function validPayload(overrides = {}) {
  return {
    action: "recheck_reprocessing",
    idempotencyKey: `test-${randomUUID()}`,
    episodeId: "episode-encounter-a",
    sessionRevision: 1,
    episodeRevision: 1,
    ...overrides,
  };
}

test("missing auth returns 401", async () => {
  const response = await fetch(`${BASE_URL}/v1/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validPayload()),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "unauthorized");
});

test("unknown action returns 400", async () => {
  const { status, body } = await createJob(validPayload({ action: "delete_everything" }));
  assert.equal(status, 400);
  assert.equal(body.error, "unknown_action");
});

test("allowlist rejection for unknown episode returns 400", async () => {
  const { status, body } = await createJob(validPayload({ episodeId: "episode-not-real" }));
  assert.equal(status, 400);
  assert.equal(body.error, "allowlist_rejected");
});

test("allowlist rejection for mismatched claimId returns 400", async () => {
  const { status, body } = await createJob(validPayload({ claimId: "CLM-EA-9999" }));
  assert.equal(status, 400);
  assert.equal(body.error, "allowlist_rejected");
});

test("duplicate idempotencyKey returns the existing job", async () => {
  const payload = validPayload();
  const first = await createJob(payload);
  assert.equal(first.status, 201);

  const second = await createJob(payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.job.id, first.body.job.id);
});

test("job can be created, polled, and reaches a terminal state", async () => {
  const { status, body } = await createJob(validPayload());
  assert.equal(status, 201);
  const jobId = body.job.id;
  assert.equal(body.job.state, "queued");

  const terminal = new Set(["completed", "failed_safe", "pending_verification", "cancelled"]);
  let job = body.job;
  const deadline = Date.now() + 20000;
  while (!terminal.has(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pollResponse = await fetch(`${BASE_URL}/v1/jobs/${jobId}`, { headers: authHeaders() });
    assert.equal(pollResponse.status, 200);
    job = (await pollResponse.json()).job;
  }
  assert.equal(job.state, "completed");
  assert.equal(job.result.statusText, "Denial upheld");
});

test("cancel on a queued job transitions it to cancelled", async () => {
  const { status, body } = await createJob(validPayload());
  assert.equal(status, 201);
  assert.equal(body.job.state, "queued");

  const cancelResponse = await fetch(`${BASE_URL}/v1/jobs/${body.job.id}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
  assert.equal(cancelResponse.status, 200);
  const cancelled = (await cancelResponse.json()).job;
  assert.equal(cancelled.state, "cancelled");

  const secondCancel = await fetch(`${BASE_URL}/v1/jobs/${body.job.id}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
  assert.equal(secondCancel.status, 200);
  assert.equal((await secondCancel.json()).job.state, "cancelled");
});

test("submit_appeal completes with a deterministic confirmation number on first submission", async () => {
  const idempotencyKey = `appeal-${randomUUID()}`;
  const { status, body } = await createJob(
    validPayload({ action: "submit_appeal", idempotencyKey }),
  );
  assert.equal(status, 201);

  const terminal = new Set(["completed", "failed_safe", "pending_verification", "cancelled"]);
  let job = body.job;
  const deadline = Date.now() + 20000;
  while (!terminal.has(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pollResponse = await fetch(`${BASE_URL}/v1/jobs/${job.id}`, { headers: authHeaders() });
    job = (await pollResponse.json()).job;
  }
  assert.equal(job.state, "completed");
  const expected = `NS-APL-${createHash("sha256").update(`CLM-EA-1001:${idempotencyKey}`).digest("hex").slice(0, 10).toUpperCase()}`;
  assert.equal(job.result.confirmationNumber, expected);
  assert.ok(job.proofs.length >= 1);
});

test("proof download requires auth and returns bytes for a known proof", async () => {
  const idempotencyKey = `investigate-${randomUUID()}`;
  const { body } = await createJob(
    validPayload({ action: "investigate_claim", idempotencyKey }),
  );

  const terminal = new Set(["completed", "failed_safe", "pending_verification", "cancelled"]);
  let job = body.job;
  const deadline = Date.now() + 20000;
  while (!terminal.has(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pollResponse = await fetch(`${BASE_URL}/v1/jobs/${job.id}`, { headers: authHeaders() });
    job = (await pollResponse.json()).job;
  }
  assert.equal(job.state, "completed");
  const proofId = job.proofs[0].proofId;

  const unauthorized = await fetch(`${BASE_URL}/v1/jobs/${job.id}/proof/${proofId}`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${BASE_URL}/v1/jobs/${job.id}/proof/${proofId}`, {
    headers: authHeaders(),
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get("content-type"), "image/png");
  const buffer = Buffer.from(await authorized.arrayBuffer());
  assert.ok(buffer.length > 0);
});

test("public portal login page is reachable without auth", async () => {
  const response = await fetch(`${BASE_URL}/portal/login`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Northstar Payer Services Demo/);
});
