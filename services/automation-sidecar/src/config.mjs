import { readFileSync } from "node:fs";
import path from "node:path";

function loadSecretFile() {
  const secretFile = process.env.AUTOMATION_SECRET_FILE;
  if (!secretFile) return {};
  try {
    return JSON.parse(readFileSync(secretFile, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read AUTOMATION_SECRET_FILE: ${error.message}`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required automation sidecar configuration: ${name}`);
  }
  return value;
}

function assertLocalOrigin(url, name) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(
      `${name} must point at the local fictional portal only (127.0.0.1 or localhost)`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function loadConfig() {
  const fromFile = loadSecretFile();
  const port = Number.parseInt(process.env.PORT || "8090", 10);

  const config = {
    port,
    apiKey: requireString(
      fromFile.apiKey || process.env.AUTOMATION_SIDECAR_API_KEY,
      "apiKey",
    ),
    portalBaseUrl: assertLocalOrigin(
      process.env.PORTAL_BASE_URL || `http://127.0.0.1:${port}/portal`,
      "PORTAL_BASE_URL",
    ),
    proofDir: path.resolve(process.env.PROOF_DIR || "/tmp/automation-proof"),
    proofTtlMs: Number.parseInt(process.env.PROOF_TTL_MS || String(60 * 60 * 1000), 10),
    jobTimeoutMs: Number.parseInt(process.env.AUTOMATION_JOB_TIMEOUT_MS || "90000", 10),
    jobConcurrency: Number.parseInt(process.env.AUTOMATION_JOB_CONCURRENCY || "2", 10),
    queueDelayMs: Number.parseInt(process.env.AUTOMATION_QUEUE_DELAY_MS || "50", 10),
    voiceMode:
      process.env.AUTOMATION_VOICE_MODE === "live" ? "live" : process.env.AUTOMATION_VOICE_MODE === "mock" ? "mock" : null,
    deepgramApiKey: fromFile.deepgramApiKey || process.env.DEEPGRAM_API_KEY || null,
    voiceRateLimitMax: Number.parseInt(process.env.AUTOMATION_VOICE_RATE_LIMIT_MAX || "5", 10),
    voiceRateLimitWindowMs: Number.parseInt(
      process.env.AUTOMATION_VOICE_RATE_LIMIT_WINDOW_MS || "60000",
      10,
    ),
    browserHeadless: process.env.AUTOMATION_BROWSER_HEADLESS !== "false",
  };

  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  if (!Number.isInteger(config.jobTimeoutMs) || config.jobTimeoutMs <= 0) {
    throw new Error("AUTOMATION_JOB_TIMEOUT_MS must be a positive integer");
  }
  if (!Number.isInteger(config.jobConcurrency) || config.jobConcurrency <= 0) {
    throw new Error("AUTOMATION_JOB_CONCURRENCY must be a positive integer");
  }

  // Live voice mode requires a Deepgram key; otherwise fall back to mock and
  // say so explicitly rather than silently pretending to be live.
  config.effectiveVoiceMode =
    config.voiceMode === "live" || (config.voiceMode === null && config.deepgramApiKey)
      ? "live"
      : "mock";

  return config;
}

export const config = loadConfig();
