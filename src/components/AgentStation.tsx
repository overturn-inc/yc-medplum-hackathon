"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApprovalControls } from "@/components/ApprovalControls";
import {
  defaultActionTypeForFixture,
  type ProposableActionType,
} from "@/domain/action-types";
import type { EpisodeView } from "@/domain/projector";
import type { PreflightCheck } from "@/domain/preflight";
import type { DomainEvent } from "@/domain/types";

const SUGGESTED_QUESTIONS: Partial<Record<EpisodeView["fixtureKey"], string[]>> = {
  "encounter-a": ["Is this ready to submit?", "What evidence do you have?", "Submit the claim"],
  "claim-a": ["Is this ready to submit?", "What's the status?"],
  "claim-b": ["What's the status?", "Why is this overdue?", "Refresh the payer status"],
  "claim-c": ["Why was this denied?", "What evidence supports reprocessing?", "Request reprocessing"],
  "claim-d": ["Why was this rejected?", "Is this a payer denial?", "Correct and resubmit"],
  "claim-e": ["What documentation is needed?", "Show me the evidence", "Send the documentation"],
  "claim-f": ["Why is this verified paid?", "Show me the evidence"],
};

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function AgentStation({
  episode,
  preflight,
  events = [],
  agentMode = "synthetic",
}: {
  episode: EpisodeView;
  preflight?: PreflightCheck[] | null;
  events?: DomainEvent[];
  agentMode?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);

  const conversation = episode.conversation ?? [];
  const suggested = SUGGESTED_QUESTIONS[episode.fixtureKey] ?? [];
  const defaultAction = defaultActionTypeForFixture(episode.fixtureKey);
  const actionType: ProposableActionType =
    (episode.proposal?.actionType as ProposableActionType | undefined) ??
    defaultAction ??
    "submit_claim";

  async function send(message: string) {
    const text = message.trim();
    if (!text || pending) return;
    setError(null);
    setDraft("");
    setPending(true);
    try {
      const response = await fetch(`/api/episodes/${episode.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          clientRequestId: crypto.randomUUID(),
          revision: episode.revision,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Chat failed");
        return;
      }
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Chat failed");
    } finally {
      setPending(false);
    }
  }

  async function refreshPayerStatus() {
    if (refreshPending) return;
    setRefreshError(null);
    setRefreshMessage(null);
    setRefreshPending(true);
    try {
      const response = await fetch(`/api/episodes/${episode.id}/refresh-status`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        setRefreshError(data.error ?? "Refresh failed");
        return;
      }
      setRefreshMessage(
        data.idempotent
          ? `Idempotent retry returned existing receipt ${data.receiptId}.`
          : `Payer status refreshed. Receipt ${data.receiptId}. Next follow-up ${data.followUpAt}.`,
      );
      router.refresh();
    } catch (error) {
      setRefreshError(
        error instanceof Error ? error.message : "Refresh failed",
      );
    } finally {
      setRefreshPending(false);
    }
  }

  return (
    <aside className="panel agent-station" aria-label="Agent station">
      <div className="agent-station-header">
        <h2>Agent station</h2>
        <span className="badge" data-testid="agent-mode-badge">
          {agentMode === "bff" ? "BFF" : "Synthetic"}
        </span>
      </div>

      <div className="chat-thread" data-testid="agent-chat-thread">
        {conversation.length === 0 ? (
          <p className="muted">
            Ask about status, reason, evidence, or the next action for this episode.
          </p>
        ) : (
          conversation.map((m) => (
            <div key={m.id} className={`chat-message chat-message-${m.role}`}>
              <div className="chat-message-meta">
                <strong>{m.role === "user" ? "You" : "Agent"}</strong>
                {m.role === "assistant" && <span className="badge">{m.intent}</span>}
                <span className="muted">{formatTimestamp(m.createdAt)}</span>
              </div>
              <p>{m.content}</p>
              {m.citations.length > 0 && (
                <ul className="citation-list" data-testid="chat-citations">
                  {m.citations.map((c, i) => (
                    <li key={`${m.id}-${c.reference}-${i}`}>
                      <span className="mono">{c.reference}</span>
                      <span className="muted">
                        {" "}
                        ({c.source}, {c.observedAt})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </div>

      {suggested.length > 0 && (
        <div className="chip-row" data-testid="suggested-questions">
          {suggested.map((q) => (
            <button
              key={q}
              type="button"
              className="filter-chip"
              onClick={() => void send(q)}
              disabled={pending}
              data-testid={`chip-${q}`}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about status, reason, evidence, or next action..."
          disabled={pending}
          data-testid="agent-chat-input"
          aria-label="Agent chat message"
          id="agent-chat-input"
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || !draft.trim()}
          data-testid="agent-chat-send"
        >
          Send
        </button>
      </form>
      {error && (
        <p data-testid="chat-error" role="alert" className="check-fail">
          {error}
        </p>
      )}

      {episode.fixtureKey === "claim-b" && (
        <>
          <h3>Payer status</h3>
          <p className="muted">
            Read-only check against the payer portal. This never needs Allow once and never marks
            the claim paid.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={refreshPending}
              onClick={() => void refreshPayerStatus()}
              data-testid="refresh-payer-status"
            >
              Refresh payer status
            </button>
          </div>
          {refreshMessage && (
            <p data-testid="refresh-status-message" className="muted">
              {refreshMessage}
            </p>
          )}
          {refreshError && (
            <p data-testid="refresh-status-error" role="alert" className="check-fail">
              {refreshError}
            </p>
          )}
        </>
      )}

      <h3>Proposal</h3>
      {episode.proposal ? (
        <>
          <p>
            <strong>What I found</strong>
            <br />
            {episode.proposal.whatIFound}
          </p>
          <p>
            <strong>Evidence used</strong>
          </p>
          <ul className="funnel-list" data-testid="proposal-evidence">
            {episode.proposal.evidenceUsed.map((ref) => (
              <li key={ref}>
                <span className="mono">{ref}</span>
              </li>
            ))}
          </ul>
          <p>
            <strong>Proposed action</strong>
            <br />
            {episode.proposal.proposedAction}
          </p>
          {episode.proposal.memberIdCorrection && (
            <p data-testid="member-id-correction">
              <strong>Member ID correction</strong>
              <br />
              <span className="mono">
                {episode.proposal.memberIdCorrection.oldMemberId}
              </span>
              {" -> "}
              <span className="mono">
                {episode.proposal.memberIdCorrection.newMemberId}
              </span>
            </p>
          )}
          <p>
            <strong>Artifact preview</strong>
          </p>
          <div className="artifact mono" data-testid="artifact-preview">
            {episode.proposal.artifactPreview}
          </div>
        </>
      ) : (
        <p className="muted">No open proposal. Resolution: {episode.resolutionState}</p>
      )}

      <ApprovalControls
        episodeId={episode.id}
        actionType={actionType}
        proposal={episode.proposal}
        preflight={preflight ?? null}
        canRepropose={!episode.proposal && defaultAction !== null}
      />

      <h3>Activity stream</h3>
      <ul className="activity-stream" data-testid="activity-stream">
        {episode.activities.map((item) => (
          <li key={item.id}>
            <div>{item.summary}</div>
            <div className="muted">
              {item.at} · {item.kind}
            </div>
          </li>
        ))}
        {events
          .filter((event) => event.type !== "demo.session.reset")
          .slice(-8)
          .map((event) => (
            <li key={event.id}>
              <div>{event.type}</div>
              <div className="muted">{event.at}</div>
            </li>
          ))}
      </ul>
    </aside>
  );
}
