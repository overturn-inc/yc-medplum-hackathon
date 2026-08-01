import express from "express";
import { requireBearerAuth } from "./auth.mjs";
import { config } from "./config.mjs";
import { cancelJob, createJob, getJob, toPublicJob } from "./jobs.mjs";
import { readProof } from "./proof.mjs";
import { RateLimiter } from "./rateLimit.mjs";

const voiceRateLimiter = new RateLimiter({
  max: config.voiceRateLimitMax,
  windowMs: config.voiceRateLimitWindowMs,
});

export function createJobsRouter() {
  const router = express.Router();
  // Auth is checked before the body is parsed so a missing/invalid token
  // always reports 401, even alongside a malformed body.
  router.use(requireBearerAuth);
  router.use(express.json({ limit: "16kb" }));

  router.post("/jobs", (request, response) => {
    const body = request.body || {};
    if (body.action === "voice_session" && !voiceRateLimiter.allow()) {
      response.status(429).json({ error: "rate_limited" });
      return;
    }

    const outcome = createJob(body);
    if (!outcome.ok) {
      response.status(outcome.status).json({ error: outcome.error, field: outcome.field });
      return;
    }
    response.status(outcome.duplicate ? 200 : 201).json({
      job: toPublicJob(outcome.job),
      duplicate: outcome.duplicate,
    });
  });

  router.get("/jobs/:id", (request, response) => {
    const job = getJob(request.params.id);
    if (!job) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.status(200).json({ job: toPublicJob(job) });
  });

  router.post("/jobs/:id/cancel", (request, response) => {
    const job = cancelJob(request.params.id);
    if (!job) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.status(200).json({ job: toPublicJob(job) });
  });

  router.get("/jobs/:id/proof/:proofId", (request, response) => {
    const job = getJob(request.params.id);
    if (!job || !job.proofs.some((proof) => proof.proofId === request.params.proofId)) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const proof = readProof(request.params.proofId);
    if (!proof) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.status(200).set("Content-Type", proof.contentType).set("Cache-Control", "no-store").send(proof.buffer);
  });

  return router;
}
