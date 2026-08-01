"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicToolJob, ToolJobAction } from "@/domain/tool-jobs";
import { isTerminalToolJobStatus } from "@/domain/tool-jobs";

type CreatableToolJobAction = Exclude<ToolJobAction, "submit_appeal">;

const POLL_INTERVAL_MS = 1200;

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  contacting: "Contacting automation sidecar",
  navigating: "Navigating payer portal",
  authenticating: "Authenticating",
  typing: "Entering claim details",
  reading: "Reading claim status",
  grounding: "Grounding on episode evidence",
  preparing: "Preparing packet",
  transcribing: "Transcribing voice session",
  speaking: "Speaking scripted script",
  finalizing: "Finalizing connector receipt",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

interface ProofAsset {
  proofId: string;
  url: string;
  contentType: string;
}

/**
 * Self-contained tool-job runner: starts a fixed-action browser/voice
 * connector job, polls until terminal, and renders progress, proof media,
 * transcript/facts, and the connector receipt. Never lets a second job start
 * while one is active, and always issues a fresh idempotency key on retry so
 * a failed/cancelled attempt does not dedupe against the new one.
 */
export function ToolJobPanel({
  episodeId,
  action,
  label,
  description,
  onSettled,
}: {
  episodeId: string;
  action: CreatableToolJobAction;
  label: string;
  description?: string;
  onSettled?: (job: PublicToolJob) => void;
}) {
  const [job, setJob] = useState<PublicToolJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proofs, setProofs] = useState<ProofAsset[]>([]);
  const settledRef = useRef(false);
  const proofUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      // Intentionally reads `.current` at unmount time (not a snapshot): the
      // array is appended to by the proof-loading effect below over the
      // component's lifetime, and every object URL ever created must be
      // revoked, not just the ones that existed when this effect ran.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const url of proofUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  const active = job ? !isTerminalToolJobStatus(job.status) : false;

  useEffect(() => {
    if (!job || !active) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/tool-jobs/${job.id}`);
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(data.error ?? "Tool job poll failed");
          return;
        }
        setJob(data.job as PublicToolJob);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Tool job poll failed");
        }
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, active]);

  useEffect(() => {
    if (!job || active || settledRef.current) return;
    settledRef.current = true;
    if (job.status === "completed") onSettled?.(job);
  }, [job, active, onSettled]);

  const jobId = job?.id ?? null;
  const proofRefsKey = job?.connectorReceipt?.proofRefs?.join(",") ?? "";

  useEffect(() => {
    if (!jobId || !proofRefsKey) return;
    const proofRefs = proofRefsKey.split(",");
    let cancelled = false;
    (async () => {
      const loaded: ProofAsset[] = [];
      for (const proofId of proofRefs) {
        try {
          const response = await fetch(`/api/tool-jobs/${jobId}/proof/${encodeURIComponent(proofId)}`);
          if (!response.ok) continue;
          const contentType = response.headers.get("content-type") ?? "application/octet-stream";
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          proofUrlsRef.current.push(url);
          loaded.push({ proofId, url, contentType });
        } catch {
          // Proof fetch failures are non-fatal; the receipt/summary still render.
        }
      }
      if (!cancelled && loaded.length > 0) setProofs(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, proofRefsKey]);

  async function start() {
    if (busy || active) return;
    setBusy(true);
    setError(null);
    settledRef.current = false;
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch("/api/tool-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId, action, idempotencyKey }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Tool job could not be started");
        return;
      }
      setJob(data.job as PublicToolJob);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Tool job could not be started");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/tool-jobs/${job.id}/cancel`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Cancel failed");
        return;
      }
      setJob(data.job as PublicToolJob);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  function retry() {
    setJob(null);
    setProofs([]);
    setError(null);
    void start();
  }

  const terminalError = job && (job.status === "failed_safe" || job.status === "cancelled");
  const latestProgress = job?.progress[job.progress.length - 1];

  return (
    <div className="tool-job-panel" data-testid={`tool-job-panel-${action}`}>
      {!job && (
        <>
          {description && <p className="muted">{description}</p>}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void start()}
            data-testid="tool-job-start"
          >
            {busy ? "Starting…" : label}
          </button>
          {error && (
            <p className="error-callout" role="alert" data-testid="tool-job-start-error">
              {error}
            </p>
          )}
        </>
      )}

      {job && (
        <div className="tool-job-run">
          <div className="tool-job-status-row">
            <span className={`badge ${job.status === "completed" ? "badge-success" : terminalError ? "danger" : ""}`}>
              {job.status.replaceAll("_", " ")}
            </span>
            {active && <span className="muted">{PHASE_LABEL[latestProgress?.phase ?? "queued"]}</span>}
          </div>

          <ol className="tool-job-progress" data-testid="tool-job-progress">
            {job.progress.map((event) => (
              <li key={event.seq}>
                <strong>{PHASE_LABEL[event.phase] ?? event.phase}</strong>
                <span>{event.message}</span>
              </li>
            ))}
          </ol>

          <div aria-live="polite" role="status" className="sr-only" data-testid="tool-job-live">
            {active
              ? `${label}: ${PHASE_LABEL[latestProgress?.phase ?? "queued"]}`
              : job.status === "completed"
                ? `${label}: completed`
                : `${label}: ${job.status.replaceAll("_", " ")}`}
          </div>

          {job.connectorReceipt && (
            <div className="tool-job-receipt" data-testid="tool-job-receipt">
              <strong>{job.connectorReceipt.summary}</strong>
              {job.connectorReceipt.confirmation && (
                <p>
                  Confirmation <code>{job.connectorReceipt.confirmation}</code>
                </p>
              )}
              <code>{job.connectorReceipt.evidenceReference}</code>
              {job.connectorReceipt.facts && Object.keys(job.connectorReceipt.facts).length > 0 && (
                <dl className="tool-job-facts">
                  {Object.entries(job.connectorReceipt.facts).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          {typeof job.result?.transcript === "string" && (
            <div className="tool-job-transcript" data-testid="tool-job-transcript">
              <span className="eyebrow">Deepgram transcript</span>
              <p>{job.result.transcript}</p>
            </div>
          )}

          {proofs.length > 0 && (
            <div className="tool-job-proofs" data-testid="tool-job-proofs">
              {proofs.map((proof) =>
                proof.contentType.startsWith("audio/") ? (
                  <audio key={proof.proofId} controls src={proof.url} data-testid="tool-job-proof-audio" />
                ) : proof.contentType.startsWith("image/") ? (
                  // next/image cannot load runtime-generated blob: URLs without a
                  // custom loader; this is a same-origin proof snapshot, not a
                  // remote asset that benefits from Next's image optimization.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={proof.proofId}
                    src={proof.url}
                    alt="Automation connector proof"
                    className="tool-job-proof-image"
                    data-testid="tool-job-proof-image"
                  />
                ) : (
                  <a key={proof.proofId} href={proof.url} download data-testid="tool-job-proof-file">
                    Download proof
                  </a>
                ),
              )}
            </div>
          )}

          {job.error && <p className="error-callout" role="alert">{job.error.message}</p>}
          {error && <p className="error-callout" role="alert">{error}</p>}

          <div className="actions">
            {active && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void cancel()}
                data-testid="tool-job-cancel"
              >
                {busy ? "Cancelling…" : "Cancel"}
              </button>
            )}
            {terminalError && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={retry}
                data-testid="tool-job-retry"
              >
                {busy ? "Starting…" : "Retry"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
