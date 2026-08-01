/**
 * Authenticated client for the automation sidecar.
 * Never exposes API keys or storage paths to callers.
 */
import type { ToolJobAction } from "@/domain/tool-jobs";

export type AutomationJobPublic = {
  id: string;
  action: string;
  status: string;
  progress: Array<{
    seq: number;
    at: string;
    phase: string;
    message: string;
    proofId?: string;
  }>;
  result?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
  receipt?: {
    id?: string;
    confirmation?: string | null;
    summary?: string;
    evidenceReference?: string;
    facts?: Record<string, string | number | boolean>;
    proofIds?: string[];
  } | null;
  proofs?: Array<{ proofId: string; contentType?: string }>;
};

export class AutomationSidecarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AutomationSidecarError";
  }
}

export interface AutomationSidecarClient {
  createJob(input: {
    action: ToolJobAction;
    idempotencyKey: string;
    episodeId: string;
    claimId?: string;
    sessionRevision: number;
    episodeRevision: number;
  }): Promise<{ job: AutomationJobPublic; duplicate: boolean }>;
  getJob(jobId: string): Promise<AutomationJobPublic>;
  cancelJob(jobId: string): Promise<AutomationJobPublic>;
  getProof(jobId: string, proofId: string): Promise<{ contentType: string; bytes: Uint8Array }>;
}

function sanitize(status: number): AutomationSidecarError {
  if (status === 401) {
    return new AutomationSidecarError("Automation sidecar unauthorized", 503, "sidecar_auth");
  }
  if (status === 400) {
    return new AutomationSidecarError("Automation sidecar rejected the action", 400, "sidecar_bad_request");
  }
  if (status === 429) {
    return new AutomationSidecarError("Automation sidecar rate limited", 429, "sidecar_rate_limited");
  }
  return new AutomationSidecarError("Automation sidecar unavailable", 503, "sidecar_unavailable");
}

export function createAutomationSidecarClient(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): AutomationSidecarClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/$/, "");

  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: "application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch {
      throw new AutomationSidecarError("Automation sidecar unreachable", 503, "sidecar_unreachable");
    }
  }

  return {
    async createJob(body) {
      const response = await request("/v1/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!response.ok) throw sanitize(response.status);
      const json = (await response.json()) as {
        job: AutomationJobPublic;
        duplicate?: boolean;
      };
      return { job: json.job, duplicate: Boolean(json.duplicate) };
    },

    async getJob(jobId) {
      const response = await request(`/v1/jobs/${encodeURIComponent(jobId)}`);
      if (!response.ok) throw sanitize(response.status);
      const json = (await response.json()) as { job: AutomationJobPublic };
      return json.job;
    },

    async cancelJob(jobId) {
      const response = await request(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw sanitize(response.status);
      const json = (await response.json()) as { job: AutomationJobPublic };
      return json.job;
    },

    async getProof(jobId, proofId) {
      const response = await request(
        `/v1/jobs/${encodeURIComponent(jobId)}/proof/${encodeURIComponent(proofId)}`,
      );
      if (!response.ok) throw sanitize(response.status);
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { contentType, bytes };
    },
  };
}

/** Local mock used when the sidecar is not configured (unit/contract tests). */
export function createMockAutomationSidecarClient(): AutomationSidecarClient {
  const jobs = new Map<string, AutomationJobPublic>();

  return {
    async createJob(input) {
      const existing = [...jobs.values()].find(
        (job) => (job as AutomationJobPublic & { idempotencyKey?: string }).id ===
          `mock-${input.idempotencyKey}`,
      );
      if (existing) return { job: existing, duplicate: true };

      const id = `mock-${input.idempotencyKey}`;
      const now = new Date().toISOString();
      const confirmation =
        input.action === "submit_appeal"
          ? `NS-APL-${input.idempotencyKey.slice(0, 10).toUpperCase()}`
          : null;
      const job: AutomationJobPublic = {
        id,
        action: input.action,
        status: "completed",
        progress: [
          { seq: 0, at: now, phase: "queued", message: "Job queued" },
          { seq: 1, at: now, phase: "navigating", message: "Opening Northstar portal" },
          { seq: 2, at: now, phase: "reading", message: "Reading claim status" },
          { seq: 3, at: now, phase: "completed", message: "Completed" },
        ],
        result: {
          denialReason:
            input.action === "investigate_claim" ? "Authorization required" : undefined,
          recheckStatus:
            input.action === "recheck_reprocessing" ? "Denial upheld" : undefined,
          transcript:
            input.action === "voice_session"
              ? "Scripted synthetic payer audio: claim denied, authorization required."
              : undefined,
          facts:
            input.action === "voice_session"
              ? {
                  status: "denied",
                  reasonCode: "CO-197",
                  claimReference: input.claimId ?? "CLM-EA-1001",
                  nextStep: "Provide authorization evidence or appeal",
                }
              : undefined,
          label: "Live Deepgram voice session / scripted synthetic payer audio / no phone dialed",
        },
        receipt: {
          id: `receipt-${input.action}-${input.episodeId}`,
          confirmation,
          summary:
            input.action === "submit_appeal"
              ? `Appeal submitted with confirmation ${confirmation}`
              : input.action === "voice_session"
                ? "Deepgram voice session completed over scripted synthetic payer audio"
                : input.action === "recheck_reprocessing"
                  ? "Portal recheck confirmed denial upheld"
                  : "Portal investigation returned authorization-required denial",
          evidenceReference: `ConnectorReceipt/${input.action}-${input.episodeId}`,
          facts:
            input.action === "voice_session"
              ? {
                  status: "denied",
                  reasonCode: "CO-197",
                  claimReference: input.claimId ?? "CLM-EA-1001",
                  nextStep: "Provide authorization evidence or appeal",
                }
              : {
                  denialReason: "Authorization required",
                  reasonCode: "CO-197",
                },
          proofIds: [`proof-${input.action}-1`],
        },
        proofs: [{ proofId: `proof-${input.action}-1`, contentType: "image/png" }],
        error: null,
      };
      jobs.set(id, job);
      return { job, duplicate: false };
    },

    async getJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        throw new AutomationSidecarError("Job not found", 404, "not_found");
      }
      return job;
    },

    async cancelJob(jobId) {
      const job = await this.getJob(jobId);
      job.status = "cancelled";
      job.progress.push({
        seq: job.progress.length,
        at: new Date().toISOString(),
        phase: "cancelled",
        message: "Cancelled",
      });
      return job;
    },

    async getProof(_jobId, _proofId) {
      // 1x1 PNG
      const png = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
        0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      return { contentType: "image/png", bytes: png };
    },
  };
}
