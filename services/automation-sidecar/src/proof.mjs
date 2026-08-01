import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { proofIndex } from "./store.mjs";

const EXTENSION_BY_CONTENT_TYPE = {
  "image/png": "png",
  "audio/wav": "wav",
};

export function ensureProofDir() {
  mkdirSync(config.proofDir, { recursive: true });
  // Proof files never outlive the in-memory job/proof index (both reset on
  // restart), so any file left over from a previous process is orphaned.
  for (const entry of readdirSync(config.proofDir)) {
    try {
      rmSync(path.join(config.proofDir, entry), { force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

export function saveProof({ jobId, kind, contentType, buffer }) {
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType] || "bin";
  const proofId = randomUUID();
  const filePath = path.join(config.proofDir, `${proofId}.${extension}`);
  writeFileSync(filePath, buffer, { mode: 0o600 });
  const record = { jobId, kind, contentType, filePath, createdAt: Date.now() };
  proofIndex.set(proofId, record);
  return { proofId, kind, contentType, createdAt: record.createdAt };
}

export function readProof(proofId) {
  const record = proofIndex.get(proofId);
  if (!record) return null;
  try {
    return { contentType: record.contentType, buffer: readFileSync(record.filePath) };
  } catch {
    return null;
  }
}

export function sweepExpiredProofs(now = Date.now()) {
  for (const [proofId, record] of proofIndex.entries()) {
    if (now - record.createdAt > config.proofTtlMs) {
      try {
        unlinkSync(record.filePath);
      } catch {
        // already gone
      }
      proofIndex.delete(proofId);
    }
  }
}

export function startProofSweeper() {
  const interval = setInterval(() => sweepExpiredProofs(), Math.min(config.proofTtlMs, 5 * 60 * 1000));
  interval.unref?.();
  return interval;
}
