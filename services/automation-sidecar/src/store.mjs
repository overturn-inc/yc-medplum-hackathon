// Process-local state. The sidecar is a single-instance demo service, so an
// in-memory store is sufficient; nothing here needs to survive a restart.

export const jobs = new Map(); // jobId -> job record
export const idempotencyIndex = new Map(); // idempotencyKey -> jobId
export const proofIndex = new Map(); // proofId -> { jobId, filePath, contentType, createdAt }

export function serializeJob(job) {
  return {
    id: job.id,
    action: job.action,
    // `status` is the app-facing contract. Keep `state` for the sidecar's
    // direct contract tests and operator diagnostics.
    status: job.state,
    state: job.state,
    episodeId: job.episodeId,
    claimId: job.claimId,
    idempotencyKey: job.idempotencyKey,
    sessionRevision: job.sessionRevision,
    episodeRevision: job.episodeRevision,
    progress: job.progress.map((entry, seq) => ({
      ...entry,
      seq,
      message: entry.message || entry.phase.replaceAll("_", " "),
    })),
    proofs: job.proofs.map((proof) => ({ ...proof })),
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
