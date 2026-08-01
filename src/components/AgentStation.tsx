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
import type { RetrievalResult } from "@/adapters/retrieval/types";

const SUGGESTED_QUESTIONS: Partial<Record<EpisodeView["fixtureKey"], string[]>> = {
  "encounter-a": ["Is this ready to submit?", "What evidence do you have?", "Submit the claim"],
  "claim-a": ["Is this ready to submit?", "What's the status?"],
  "claim-b": ["What's the status?", "Why is this overdue?", "Refresh the payer status"],
  "claim-c": ["Why was this denied?", "What evidence supports reprocessing?", "Request reprocessing"],
  "claim-d": ["Why was this rejected?", "Is this a payer denial?", "Correct and resubmit"],
  "claim-e": ["What documentation is needed?", "Show me the evidence", "Send the documentation"],
  "claim-f": ["Why is this verified paid?", "Show me the evidence"],
};

const ACTION_META: Record<ProposableActionType, { target: string; impact: string }> = {
  submit_claim: {
    target: "Synthetic clearinghouse gateway",
    impact: "Creates a submission receipt. It does not mean the payer accepted or paid the claim.",
  },
  request_reprocessing: {
    target: "Synthetic payer message channel",
    impact: "Requests payer review of the original claim. Denied status remains until a newer payer response arrives.",
  },
  correct_and_resubmit: {
    target: "Synthetic clearinghouse gateway",
    impact: "Creates and submits a corrected claim while preserving the rejected original for audit.",
  },
  send_documentation: {
    target: "Synthetic payer attachment channel",
    impact: "Sends the requested packet and schedules follow-up. It does not adjudicate the claim.",
  },
};

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function AgentStation({
  episode,
  preflight,
  events = [],
  agentMode = "synthetic",
  mossConfigured = false,
}: {
  episode: EpisodeView;
  preflight?: PreflightCheck[] | null;
  events?: DomainEvent[];
  agentMode?: string;
  mossConfigured?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalResult | null>(null);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);

  const conversation = episode.conversation ?? [];
  const suggested = SUGGESTED_QUESTIONS[episode.fixtureKey] ?? [];
  const defaultAction = defaultActionTypeForFixture(episode.fixtureKey);
  const actionType: ProposableActionType =
    (episode.proposal?.actionType as ProposableActionType | undefined) ??
    defaultAction ??
    "submit_claim";
  const actionMeta = ACTION_META[actionType];

  async function send(message: string) {
    const text = message.trim();
    if (!text || pending) return;
    setError(null);
    setRetrievalError(null);
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
      setRetrieval(data.retrieval ?? null);
      setRetrievalError(data.retrievalError ?? null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chat failed");
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
    } catch (caught) {
      setRefreshError(caught instanceof Error ? caught.message : "Refresh failed");
    } finally {
      setRefreshPending(false);
    }
  }

  return (
    <aside className="agent-station" aria-label="Claim-scoped agent and decision">
      <section className="panel agent-chat-card">
        <div className="agent-station-header">
          <div>
            <span className="eyebrow">Claim-scoped copilot</span>
            <h2>Ask the agent</h2>
          </div>
          <span className="agent-connection" data-testid="agent-mode-badge">
            <span aria-hidden className="status-dot" />
            {agentMode === "bff" ? "BFF configured" : "Synthetic"}
          </span>
        </div>
        <p className="agent-boundary">
          Grounded answers only · no silent local fallback
          {mossConfigured ? " · Moss retrieval live" : ""}
        </p>

        {mossConfigured && (
          <div className="moss-retrieval" data-testid="moss-retrieval">
            <div className="moss-retrieval-header">
              <span>
                <strong>Moss evidence retrieval</strong>
                <small>
                  Synthetic claim scope
                  {retrieval
                    ? ` · ${retrieval.execution === "local-in-memory" ? "Local in-memory" : "Cloud"}`
                    : ""}
                </small>
              </span>
              {retrieval ? (
                <span className="badge success">{retrieval.latencyMs.toFixed(1)} ms</span>
              ) : (
                <span className="badge">Ready</span>
              )}
            </div>
            {retrievalError ? (
              <p className="error-callout" role="status">{retrievalError}</p>
            ) : retrieval ? (
              retrieval.documents.length > 0 ? (
                <ul className="moss-result-list">
                  {retrieval.documents.map((document) => (
                    <li key={document.id}>
                      <span>
                        <strong>{document.title}</strong>
                        <code>{document.reference}</code>
                      </span>
                      <small>{document.documentType} · {document.score.toFixed(3)}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No documents passed the episode-scope guard.</p>
              )
            ) : (
              <p className="muted">Ask the agent to retrieve claim evidence from the live Moss index.</p>
            )}
          </div>
        )}

        <div className="chat-thread" data-testid="agent-chat-thread">
          {conversation.length === 0 ? (
            <div className="empty-chat">
              <strong>Ask about this episode</strong>
              <span>Status, denial reason, evidence, or the safest next action.</span>
            </div>
          ) : (
            conversation.map((message) => (
              <div key={message.id} className={`chat-message chat-message-${message.role}`}>
                <div className="chat-message-meta">
                  <strong>{message.role === "user" ? "You" : "Agent"}</strong>
                  {message.role === "assistant" && <span className="badge">{message.intent}</span>}
                  <span className="muted">{formatTimestamp(message.createdAt)}</span>
                </div>
                <p>{message.content}</p>
                {message.citations.length > 0 && (
                  <ul className="citation-list" data-testid="chat-citations">
                    {message.citations.map((citation, index) => (
                      <li key={`${message.id}-${citation.reference}-${index}`}>
                        <a href={`#evidence-${citation.reference.split("/").at(-1)}`}>
                          ◆ <span className="mono">{citation.reference}</span>
                        </a>
                        <span className="muted">{citation.source} · {citation.observedAt}</span>
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
            {suggested.map((question) => (
              <button
                key={question}
                type="button"
                className="filter-chip"
                onClick={() => void send(question)}
                disabled={pending}
                data-testid={`chip-${question}`}
              >
                {question}
              </button>
            ))}
          </div>
        )}

        <form className="chat-input-row" onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}>
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about this claim..."
            disabled={pending}
            data-testid="agent-chat-input"
            aria-label="Agent chat message"
            id="agent-chat-input"
          />
          <button type="submit" className="btn btn-primary" disabled={pending || !draft.trim()} data-testid="agent-chat-send">
            {pending ? "Working" : "Send"}
          </button>
        </form>
        {error && <p data-testid="chat-error" role="alert" className="error-callout">{error}</p>}

        {episode.fixtureKey === "claim-b" && (
          <div className="readonly-action">
            <div><strong>Read-only payer status</strong><p>Refresh never needs Allow once and never marks the claim paid.</p></div>
            <button type="button" className="btn" disabled={refreshPending} onClick={() => void refreshPayerStatus()} data-testid="refresh-payer-status">
              {refreshPending ? "Refreshing" : "Refresh status"}
            </button>
            {refreshMessage && <p data-testid="refresh-status-message" className="success-callout">{refreshMessage}</p>}
            {refreshError && <p data-testid="refresh-status-error" role="alert" className="error-callout">{refreshError}</p>}
          </div>
        )}
      </section>

      <section className="panel decision-card">
        <header className="decision-header">
          <div><span className="eyebrow">Decision boundary</span><h2>Next action</h2></div>
          <span className="badge warn">Nothing sent yet</span>
        </header>

        {episode.proposal ? (
          <div className="proposal-content">
            <span className="proposal-ready">Proposal ready for review</span>
            <div className="proposal-field">
              <span>What the agent found</span>
              <p>{episode.proposal.whatIFound}</p>
            </div>
            <div className="proposal-field">
              <span>Evidence used</span>
              <ul className="proposal-evidence" data-testid="proposal-evidence">
                {episode.proposal.evidenceUsed.map((reference) => (
                  <li key={reference}><a href={`#evidence-${reference.split("/").at(-1)}`}>◆ <code>{reference}</code></a></li>
                ))}
              </ul>
            </div>
            <div className="proposal-field">
              <span>Proposed action</span>
              <p><strong>{episode.proposal.proposedAction}</strong></p>
              <small>Target: {actionMeta.target}</small>
            </div>
            {episode.proposal.memberIdCorrection && (
              <div className="correction-preview" data-testid="member-id-correction">
                <span>Member ID correction</span>
                <code>{episode.proposal.memberIdCorrection.oldMemberId}</code>
                <b aria-hidden>→</b>
                <code>{episode.proposal.memberIdCorrection.newMemberId}</code>
              </div>
            )}
            <div className="proposal-field">
              <span>Artifact preview</span>
              <pre className="artifact mono" data-testid="artifact-preview">{episode.proposal.artifactPreview}</pre>
            </div>
            <div className="proposal-field expected-impact">
              <span>Expected impact</span>
              <p>{actionMeta.impact}</p>
            </div>
          </div>
        ) : (
          <div className="no-action-state">
            <strong>{defaultAction ? "No open proposal" : "No write action available"}</strong>
            <p>
              {defaultAction
                ? `Resolution is ${episode.resolutionState}. Recreate the proposal before any external action.`
                : "Reading and comparing sources does not require approval. This reconciled claim has no pending external write."}
            </p>
          </div>
        )}

        <ApprovalControls
          episodeId={episode.id}
          actionType={actionType}
          proposal={episode.proposal}
          preflight={preflight ?? null}
          canRepropose={!episode.proposal && defaultAction !== null}
        />
      </section>

      <section className="panel activity-card">
        <header className="section-header compact"><div><span className="eyebrow">Append-only record</span><h2>Activity and audit</h2></div><span className="muted">Newest last</span></header>
        <ul className="activity-stream" data-testid="activity-stream">
          {episode.activities.map((item) => (
            <li key={item.id}>
              <div>{item.summary}</div>
              <div className="muted">{item.at} · {item.kind}</div>
            </li>
          ))}
          {events.filter((event) => event.type !== "demo.session.reset").slice(-8).map((event) => (
            <li key={event.id}><div>{event.type}</div><div className="muted">{event.at}</div></li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
