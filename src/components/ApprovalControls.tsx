"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AgentProposal } from "@/domain/types";
import type { ProposableActionType } from "@/domain/action-types";
import type { PreflightCheck } from "@/domain/preflight";

type Proposal = AgentProposal;
type Checks = PreflightCheck[] | null;

const MESSAGE_KEY = "harborview-approval-message";

const SUCCESS_MESSAGE: Record<
  ProposableActionType,
  (data: Record<string, unknown>) => string
> = {
  submit_claim: (data) =>
    `Submitted. Receipt ${data.receiptId}. Received by clearinghouse; adjudication not yet found.`,
  request_reprocessing: (data) =>
    `Reprocessing requested. Receipt ${data.receiptId}. Adjudication is not paid.`,
  correct_and_resubmit: (data) =>
    `Corrected claim ${data.correctedClaimId} resubmitted. Receipt ${data.receiptId}.`,
  send_documentation: (data) =>
    `Documentation sent (${data.packetReference}). Receipt ${data.receiptId}. Next follow-up ${data.followUpAt}.`,
};

export function ApprovalControls({
  episodeId,
  actionType,
  proposal,
  preflight,
  canRepropose = false,
}: {
  episodeId: string;
  actionType: ProposableActionType;
  proposal: Proposal | null;
  preflight?: Checks;
  /** Shows a "Re-propose" button when there is no open proposal but one can be recreated. */
  canRepropose?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"allow_once" | "deny" | "repropose" | null>(null);
  const pending = busy !== null;
  const [message, setMessage] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return sessionStorage.getItem(MESSAGE_KEY);
  });
  const [error, setError] = useState<string | null>(null);
  /** Fingerprint of a proposal that was just denied/allowed in this client. */
  const [consumedFingerprint, setConsumedFingerprint] = useState<string | null>(null);
  const visibleProposal =
    proposal && proposal.fingerprint !== consumedFingerprint ? proposal : null;

  useEffect(() => {
    if (message) {
      sessionStorage.removeItem(MESSAGE_KEY);
    }
  }, [message]);

  async function decide(decision: "allow_once" | "deny") {
    if (!proposal || pending) return;
    setError(null);
    setMessage(null);
    setBusy(decision);
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episodeId,
          actionType,
          decision,
          proposalId: proposal.id,
          payloadDigest: proposal.payloadDigest,
          episodeRevision: proposal.episodeRevision,
          fingerprint: proposal.fingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Request failed");
        return;
      }
      let nextMessage: string;
      if (decision === "deny") {
        nextMessage =
          "Denied. No external write, artifact, receipt, or follow-up was created.";
      } else if (data.pendingVerification) {
        nextMessage = `Pending verification. ${data.message ?? "No success receipt created."}`;
      } else if (data.idempotent) {
        nextMessage = `Idempotent retry returned existing receipt ${data.receiptId}.`;
      } else {
        nextMessage =
          SUCCESS_MESSAGE[actionType]?.(data) ?? `Action completed. Receipt ${data.receiptId}.`;
      }
      sessionStorage.setItem(MESSAGE_KEY, nextMessage);
      setMessage(nextMessage);
      setConsumedFingerprint(proposal.fingerprint);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function repropose() {
    if (pending) return;
    setError(null);
    setMessage(null);
    setBusy("repropose");
    try {
      const response = await fetch("/api/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId, actionType }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not create a new proposal");
        return;
      }
      const nextMessage = `New proposal created: ${data.proposal?.title ?? actionType}. Review before approving.`;
      sessionStorage.setItem(MESSAGE_KEY, nextMessage);
      setMessage(nextMessage);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create a new proposal",
      );
    } finally {
      setBusy(null);
    }
  }

  if (!visibleProposal && !canRepropose && !message && !error) {
    return <p className="muted">No pending proposal for this episode.</p>;
  }

  return (
    <section className="approval-boundary" aria-label="Approval controls">
      {preflight && (
        <ul className="check-list" data-testid="preflight-checks">
          {preflight.map((check) => (
            <li key={check.id}>
              <span className={check.passed ? "check-pass" : "check-fail"} aria-hidden>
                {check.passed ? "✓" : "×"}
              </span>
              <div>
                <strong>{check.label}</strong>
                <div className="muted">{check.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {visibleProposal ? (
        <>
          <p className="approval-scope mono" data-testid="approval-scope">
            Bound to proposal {visibleProposal.id} · revision {visibleProposal.episodeRevision} · fingerprint {visibleProposal.fingerprint.slice(0, 8)}
          </p>
          <div className="actions approval-actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={() => decide("deny")}
              data-testid="deny-action"
            >
              {busy === "deny" ? "Denying…" : "Deny"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => decide("allow_once")}
              data-testid="allow-once"
            >
              {busy === "allow_once" ? "Executing…" : "Allow once"}
            </button>
          </div>
        </>
      ) : (
        canRepropose && (
          <div className="actions approval-actions">
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={repropose}
              data-testid="repropose-action"
            >
              {busy === "repropose" ? "Preparing…" : "Re-propose"}
            </button>
          </div>
        )
      )}
      {pending && (
        <p className="pending-callout" role="status" data-testid="approval-pending">
          {busy === "allow_once"
            ? "Executing the approved action and verifying the resulting state…"
            : busy === "deny"
              ? "Recording the denial without performing an external write…"
              : "Preparing a fresh proposal for review…"}
        </p>
      )}
      {message && (
        <p data-testid="approval-message" className="success-callout">
          {message}
        </p>
      )}
      {error && (
        <p data-testid="approval-error" role="alert" className="error-callout">
          {error}
        </p>
      )}
    </section>
  );
}
