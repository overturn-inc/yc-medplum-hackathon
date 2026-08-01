import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { ACTIONS, resolveEpisode, IDEMPOTENCY_KEY_PATTERN } from "./allowlist.mjs";
import { ACTION_HANDLERS } from "./actions/index.mjs";
import { withPortalPage } from "./browser.mjs";
import { idempotencyIndex, jobs, serializeJob } from "./store.mjs";
import { saveProof } from "./proof.mjs";

const TERMINAL_STATES = new Set(["completed", "failed_safe", "cancelled", "pending_verification"]);

let activeCount = 0;
const queue = [];

function validateCreateInput(input) {
  if (!input || typeof input !== "object") {
    return { status: 400, error: "invalid_request" };
  }
  const { action, idempotencyKey, episodeId, claimId, sessionRevision, episodeRevision } = input;

  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    return { status: 400, error: "unknown_action" };
  }
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return { status: 400, error: "invalid_idempotency_key" };
  }
  if (!Number.isInteger(sessionRevision) || sessionRevision < 0) {
    return { status: 400, error: "invalid_request", field: "sessionRevision" };
  }
  if (!Number.isInteger(episodeRevision) || episodeRevision < 0) {
    return { status: 400, error: "invalid_request", field: "episodeRevision" };
  }
  if (claimId !== undefined && typeof claimId !== "string") {
    return { status: 400, error: "invalid_request", field: "claimId" };
  }

  return { action, idempotencyKey, episodeId, claimId, sessionRevision, episodeRevision };
}

function releaseSlot(job) {
  if (job._slotReleased) return;
  job._slotReleased = true;
  activeCount = Math.max(0, activeCount - 1);
  drainQueue();
}

function finalize(job, patch) {
  if (TERMINAL_STATES.has(job.state)) return;
  job.state = patch.state;
  if ("result" in patch) job.result = patch.result;
  if ("error" in patch) job.error = patch.error;
  job.updatedAt = Date.now();
  if (["completed", "pending_verification", "failed_safe", "cancelled"].includes(patch.state)) {
    job.progress.push({ phase: patch.state, at: job.updatedAt });
  }
  releaseSlot(job);
}

function addProgress(job, phase) {
  if (TERMINAL_STATES.has(job.state)) return;
  job.progress.push({ phase, at: Date.now() });
  job.updatedAt = Date.now();
}

function removeFromQueue(jobId) {
  const index = queue.indexOf(jobId);
  if (index !== -1) queue.splice(index, 1);
}

function drainQueue() {
  while (activeCount < config.jobConcurrency && queue.length > 0) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (!job || TERMINAL_STATES.has(job.state)) continue;
    activeCount += 1;
    void runJob(job);
  }
}

async function runJob(job) {
  job.state = "running";
  job.updatedAt = Date.now();
  job._slotReleased = false;

  const timeoutHandle = setTimeout(() => {
    if (TERMINAL_STATES.has(job.state)) return;
    job.cancelRequested = true;
    job._activeContext?.close().catch(() => {});
    finalize(job, { state: "failed_safe", error: { message: "job_timeout" } });
  }, config.jobTimeoutMs);

  try {
    const handler = ACTION_HANDLERS[job.action];
    const entry = resolveEpisode(job.episodeId, job.claimId);
    const ctx = {
      entry,
      addProgress: (phase) => addProgress(job, phase),
      saveScreenshot: async (buffer) => {
        const proof = saveProof({ jobId: job.id, kind: "screenshot", contentType: "image/png", buffer });
        job.proofs.push(proof);
        return proof;
      },
      saveAudioProof: async (buffer) => {
        const proof = saveProof({ jobId: job.id, kind: "audio", contentType: "audio/wav", buffer });
        job.proofs.push(proof);
        return proof;
      },
    };

    const outcome = handler.needsBrowser
      ? await withPortalPage(async (page, context) => {
          job._activeContext = context;
          try {
            return await handler.run(job, { ...ctx, page });
          } finally {
            job._activeContext = null;
          }
        })
      : await handler.run(job, ctx);

    if (job.cancelRequested) {
      finalize(job, { state: "cancelled" });
      return;
    }
    finalize(job, outcome);
  } catch (error) {
    if (job.cancelRequested) {
      finalize(job, { state: "cancelled" });
    } else {
      finalize(job, { state: "failed_safe", error: { message: error?.message || "action_failed" } });
    }
  } finally {
    clearTimeout(timeoutHandle);
    releaseSlot(job);
  }
}

export function createJob(input) {
  const validated = validateCreateInput(input);
  if (validated.status) return { ok: false, status: validated.status, error: validated.error, field: validated.field };

  const existingJobId = idempotencyIndex.get(validated.idempotencyKey);
  if (existingJobId) {
    const existingJob = jobs.get(existingJobId);
    if (existingJob) return { ok: true, job: existingJob, duplicate: true };
  }

  const entry = resolveEpisode(validated.episodeId, validated.claimId);
  if (!entry) {
    return { ok: false, status: 400, error: "allowlist_rejected" };
  }

  const now = Date.now();
  const job = {
    id: `job_${randomUUID()}`,
    action: validated.action,
    episodeId: validated.episodeId,
    claimId: entry.claimId,
    idempotencyKey: validated.idempotencyKey,
    sessionRevision: validated.sessionRevision,
    episodeRevision: validated.episodeRevision,
    state: "reserved",
    progress: [],
    proofs: [],
    result: null,
    error: null,
    cancelRequested: false,
    _activeContext: null,
    _slotReleased: true,
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(job.id, job);
  idempotencyIndex.set(job.idempotencyKey, job.id);

  job.state = "queued";
  job.progress.push({ phase: "queued", at: now });
  queue.push(job.id);
  setTimeout(() => drainQueue(), config.queueDelayMs);

  return { ok: true, job, duplicate: false };
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (TERMINAL_STATES.has(job.state)) return job;

  job.cancelRequested = true;
  if (job.state === "queued") {
    removeFromQueue(job.id);
  } else if (job.state === "running") {
    job._activeContext?.close().catch(() => {});
  }
  finalize(job, { state: "cancelled" });
  return job;
}

export function toPublicJob(job) {
  return serializeJob(job);
}
