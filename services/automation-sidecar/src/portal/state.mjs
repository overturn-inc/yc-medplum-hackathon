import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { EPISODE_ALLOWLIST } from "../allowlist.mjs";

const STATE_FILE = process.env.PORTAL_STATE_FILE || path.join(os.tmpdir(), "northstar-portal-state.json");

function deterministicInitialClaims() {
  const claims = {};
  for (const entry of Object.values(EPISODE_ALLOWLIST)) {
    claims[entry.claimId] = {
      claimId: entry.claimId,
      patientLabel: "Synthetic patient (Encounter A)",
      denialReasonCode: entry.denialReasonCode,
      denialReasonText: entry.denialReasonText,
      onFileAuthNumber: entry.onFileAuthNumber,
      reprocessingStatus: "upheld",
      appeal: {
        submitted: false,
        confirmationNumber: null,
        submittedIdempotencyKey: null,
      },
    };
  }
  return claims;
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.claims) return parsed;
    } catch {
      // fall through to deterministic defaults
    }
  }
  return { claims: deterministicInitialClaims(), sessions: {} };
}

const state = loadState();

function persist() {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Best-effort only; the deterministic in-memory state remains authoritative.
  }
}

export function getClaim(claimId) {
  return state.claims[claimId] || null;
}

export function markReprocessingRechecked(claimId) {
  const claim = state.claims[claimId];
  if (!claim) return null;
  // Deterministic demo outcome: the payer never reverses on recheck.
  claim.reprocessingStatus = "upheld";
  persist();
  return claim;
}

export function submitAppeal(claimId, idempotencyKey, confirmationNumber) {
  const claim = state.claims[claimId];
  if (!claim) return null;
  if (!claim.appeal.submitted) {
    claim.appeal.submitted = true;
    claim.appeal.confirmationNumber = confirmationNumber;
    claim.appeal.submittedIdempotencyKey = idempotencyKey;
  }
  persist();
  return { ...claim.appeal };
}

export function createSession(username) {
  const token = randomUUID();
  state.sessions[token] = { username, createdAt: Date.now() };
  persist();
  return token;
}

export function isValidSession(token) {
  return Boolean(token && state.sessions[token]);
}

export function resetPortalState() {
  state.claims = deterministicInitialClaims();
  state.sessions = {};
  persist();
}
