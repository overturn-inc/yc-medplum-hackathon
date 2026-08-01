"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { AgentProposal } from "@/domain/types";
import type { PreflightCheck } from "@/domain/preflight";

type Proposal = AgentProposal;
type Checks = PreflightCheck[] | null;

const MESSAGE_KEY = "harborview-approval-message";

export function ApprovalControls({
  episodeId,
  actionType,
  proposal,
  preflight,
}: {
  episodeId: string;
  actionType: "submit_claim" | "request_reprocessing";
  proposal: Proposal | null;
  preflight?: Checks;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return sessionStorage.getItem(MESSAGE_KEY);
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (message) {
      sessionStorage.removeItem(MESSAGE_KEY);
    }
  }, [message]);

  if (!proposal && !message && !error) {
    return <p className="muted">No pending proposal for this episode.</p>;
  }

  async function decide(decision: "allow_once" | "deny") {
    if (!proposal) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
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
          actionType === "submit_claim"
            ? `Submitted. Receipt ${data.receiptId}.`
            : `Reprocessing requested. Receipt ${data.receiptId}. Adjudication is not paid.`;
      }
      sessionStorage.setItem(MESSAGE_KEY, nextMessage);
      setMessage(nextMessage);
      router.refresh();
    });
  }

  return (
    <section aria-label="Approval controls">
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
      {proposal && (
        <>
          <p className="muted mono" data-testid="approval-scope">
            proposal={proposal.id} rev={proposal.episodeRevision} fp=
            {proposal.fingerprint.slice(0, 8)}
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={() => decide("deny")}
              data-testid="deny-action"
            >
              Deny
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => decide("allow_once")}
              data-testid="allow-once"
            >
              Allow once
            </button>
          </div>
        </>
      )}
      {message && (
        <p data-testid="approval-message" className="muted">
          {message}
        </p>
      )}
      {error && (
        <p data-testid="approval-error" role="alert" className="check-fail">
          {error}
        </p>
      )}
    </section>
  );
}
