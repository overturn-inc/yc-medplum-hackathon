#!/usr/bin/env node
// Live contract smoke test against a running automation-sidecar instance
// (local or deployed). Exercises the same guarantees as tests/contract.test.mjs
// without depending on the test runner, so it can be pointed at a real host.
//
// Usage:
//   BASE_URL=http://127.0.0.1:8090 AUTOMATION_SIDECAR_API_KEY=... node scripts/contract-smoke.mjs

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8090";
const API_KEY = process.env.AUTOMATION_SIDECAR_API_KEY;

if (!API_KEY) {
  console.error("AUTOMATION_SIDECAR_API_KEY is required.");
  process.exit(1);
}

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`ok - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

function basePayload(overrides = {}) {
  return {
    action: "recheck_reprocessing",
    idempotencyKey: `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    episodeId: "episode-encounter-a",
    sessionRevision: 1,
    episodeRevision: 1,
    ...overrides,
  };
}

async function pollUntilTerminal(jobId, timeoutMs = 30000) {
  const terminal = new Set(["completed", "failed_safe", "pending_verification", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  let job;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}/v1/jobs/${jobId}`, { headers: authHeaders() });
    job = (await response.json()).job;
    if (terminal.has(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return job;
}

async function main() {
  console.log(`Running contract smoke against ${BASE_URL}`);

  {
    const response = await fetch(`${BASE_URL}/health/ready`);
    check("health/ready returns 200", response.status === 200);
  }

  {
    const response = await fetch(`${BASE_URL}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload()),
    });
    check("missing auth returns 401", response.status === 401);
  }

  {
    const response = await fetch(`${BASE_URL}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(basePayload({ action: "not_a_real_action" })),
    });
    check("unknown action returns 400", response.status === 400);
  }

  {
    const response = await fetch(`${BASE_URL}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(basePayload({ episodeId: "episode-not-real" })),
    });
    check("allowlist rejection returns 400", response.status === 400);
  }

  {
    const payload = basePayload();
    const first = await fetch(`${BASE_URL}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const firstBody = await first.json();
    const second = await fetch(`${BASE_URL}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const secondBody = await second.json();
    check(
      "duplicate idempotencyKey returns the existing job",
      second.status === 200 && secondBody.job.id === firstBody.job.id,
    );
  }

  {
    const created = await fetch(`${BASE_URL}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(basePayload()),
    });
    const { job } = await created.json();
    const cancelled = await fetch(`${BASE_URL}/v1/jobs/${job.id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    const cancelledBody = await cancelled.json();
    check("cancel returns 200 with a terminal state", cancelled.status === 200 && cancelledBody.job.state === "cancelled");
  }

  {
    const created = await fetch(`${BASE_URL}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(basePayload({ action: "investigate_claim" })),
    });
    const { job } = await created.json();
    const finalJob = await pollUntilTerminal(job.id);
    check(
      "investigate_claim reaches a terminal state with progress recorded",
      Boolean(finalJob) && finalJob.progress.length > 1,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} contract smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll contract smoke checks passed.");
}

main().catch((error) => {
  console.error("Contract smoke run failed:", error);
  process.exit(1);
});
