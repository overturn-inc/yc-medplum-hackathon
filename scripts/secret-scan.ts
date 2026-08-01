import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const CANARY =
  process.env.SECRET_CANARY || "demo-secret-canary-not-a-real-credential";

const FAKE_SECRETS = [
  CANARY,
  "NEXT_PUBLIC_MEDPLUM_CLIENT_SECRET",
  "NEXT_PUBLIC_BFF_API_KEY",
];

function walk(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function scanText(label: string, text: string): string[] {
  const hits: string[] = [];
  for (const secret of FAKE_SECRETS) {
    if (text.includes(secret)) hits.push(`${label}: ${secret}`);
  }
  return hits;
}

function assertNoCanary(label: string, text: string): void {
  const hits = scanText(label, text);
  if (hits.length) {
    console.error("Secret canary scan failed:");
    for (const hit of hits) console.error(` - ${hit}`);
    process.exit(1);
  }
}

async function waitForServer(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/demo`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(1000, () => {
          req.destroy(new Error("timeout"));
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Server did not become ready on port ${port}`);
}

async function fetchText(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
  });
  return { status: response.status, body: await response.text() };
}

function stopProcess(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

async function runHttpCanaryScan(): Promise<void> {
  const port = 3457;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "pms-secret-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DEMO_DATA_DIR: dataDir,
    SECRET_CANARY: CANARY,
    // Inject canaries only into server env; responses must not echo them.
    BFF_API_KEY: CANARY,
    MEDPLUM_CLIENT_SECRET: CANARY,
    HEALTHCARE_MODE: "local",
    AGENT_MODE: "synthetic",
  };

  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForServer(port);

    const dashboard = await fetchText(`http://127.0.0.1:${port}/dashboard`);
    assertNoCanary("dashboard HTML", dashboard.body);

    const demo = await fetchText(`http://127.0.0.1:${port}/api/demo`);
    assertNoCanary("/api/demo JSON", demo.body);

    const approvalError = await fetchText(`http://127.0.0.1:${port}/api/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        episodeId: "episode-encounter-a",
        actionType: "submit_claim",
        decision: "allow_once",
        proposalId: "tampered",
        payloadDigest: "tampered",
        episodeRevision: 1,
        fingerprint: CANARY,
      }),
    });
    if (approvalError.status !== 409 && approvalError.status !== 400) {
      console.error(
        `Expected approval scope error status 409/400, got ${approvalError.status}: ${approvalError.body}`,
      );
      process.exit(1);
    }
    assertNoCanary("approval error JSON", approvalError.body);

    // Connected-adapter error path: temporary BFF-mode process.
    stopProcess(child);
    await new Promise((r) => setTimeout(r, 500));

    const bffDataDir = mkdtempSync(path.join(os.tmpdir(), "pms-secret-bff-"));
    const bffEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      DEMO_DATA_DIR: bffDataDir,
      SECRET_CANARY: CANARY,
      AGENT_MODE: "bff",
      BFF_BASE_URL: "http://127.0.0.1:9",
      BFF_API_KEY: CANARY,
      HEALTHCARE_MODE: "local",
    };
    const bffChild = spawn("npx", ["next", "start", "-p", String(port)], {
      cwd: ROOT,
      env: bffEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bffErr = "";
    bffChild.stderr?.on("data", (chunk: Buffer) => {
      bffErr += chunk.toString("utf8");
    });

    try {
      await waitForServer(port);
      const bffDemo = await fetchText(`http://127.0.0.1:${port}/api/demo`);
      assertNoCanary("connected BFF /api/demo", bffDemo.body);
      const bffHtml = await fetchText(`http://127.0.0.1:${port}/dashboard`);
      assertNoCanary("connected BFF dashboard HTML", bffHtml.body);
      const bffAllow = await fetchText(`http://127.0.0.1:${port}/api/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          episodeId: "episode-encounter-a",
          actionType: "submit_claim",
          decision: "allow_once",
          proposalId: "x",
          payloadDigest: "y",
          episodeRevision: 1,
          fingerprint: "z",
        }),
      });
      if (bffAllow.status !== 503) {
        console.error(
          `Expected BFF allow failure 503, got ${bffAllow.status}: ${bffAllow.body}`,
        );
        process.exit(1);
      }
      assertNoCanary("connected BFF approval error", bffAllow.body);
      if (!/unavailable|BFF|redacted/i.test(bffAllow.body)) {
        console.error("BFF approval error body missing sanitized failure signal");
        process.exit(1);
      }
    } finally {
      stopProcess(bffChild);
      void bffErr;
    }
  } catch (error) {
    console.error("HTTP canary scan failed:", error);
    if (stderr) console.error(stderr.slice(-2000));
    stopProcess(child);
    process.exit(1);
  } finally {
    stopProcess(child);
  }
}

// Static client artifact scan
const targets = [
  ...walk(path.join(ROOT, ".next", "static")),
  ...walk(path.join(ROOT, ".next", "server", "app")).filter(
    (f) => f.endsWith(".html") || f.endsWith(".js") || f.endsWith(".rsc"),
  ),
];

const sourceHits = walk(path.join(ROOT, "src"))
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const hits: string[] = [];
    if (/NEXT_PUBLIC_.*(SECRET|API_KEY|TOKEN)/.test(text)) {
      hits.push(`${file}: forbidden NEXT_PUBLIC credential pattern`);
    }
    if (text.includes(CANARY) && !file.includes("secret")) {
      hits.push(`${file}: canary leaked into source`);
    }
    return hits;
  });

const buildHits = targets.flatMap((file) =>
  scanText(file, readFileSync(file, "utf8")),
);

if (sourceHits.length || buildHits.length) {
  console.error("Secret canary scan failed:");
  for (const hit of [...sourceHits, ...buildHits]) console.error(` - ${hit}`);
  process.exit(1);
}

runHttpCanaryScan()
  .then(() => {
    console.log(
      `Secret scan passed (${targets.length} build artifacts + live HTML/JSON/approval/BFF error paths; canary absent).`,
    );
  })
  .catch((error) => {
    console.error("HTTP canary scan failed:", error);
    process.exit(1);
  });
