import { AgentStation } from "@/components/AgentStation";
import type { EpisodeView } from "@/domain/projector";
import type { PreflightCheck } from "@/domain/preflight";
import type { DomainEvent, SourceObservation } from "@/domain/types";

const LIFECYCLE_ORDER = [
  "Encounter",
  "Claim",
  "Clearinghouse",
  "Payer",
  "Remittance",
  "Posting",
] as const;

const BUCKET_LABELS: Record<string, string> = {
  needs_claim: "Needs claim",
  ready_to_submit: "Ready to submit",
  rejected_before_adjudication: "Rejected before adjudication",
  awaiting_payer: "Awaiting payer",
  action_required: "Action required",
  denied_under_resolution: "Denied — in resolution",
  paid_needs_posting: "Paid — needs posting",
  reconciled_or_closed: "Reconciled and closed",
};

function latestObservation(
  episode: EpisodeView,
  source: SourceObservation["source"],
) {
  return episode.observations
    .filter((observation) => observation.source === source)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function money(value: number | null) {
  return value == null ? "Not reported" : `$${value.toFixed(2)}`;
}

function sourceStage(
  label: string,
  observation: SourceObservation | undefined,
) {
  return {
    label,
    raw: observation?.rawStatus ?? "No observation",
    normalized: observation?.normalizedStatus ?? "Not reported",
    at: observation?.observedAt ?? "Timestamp unavailable",
    evidence: observation?.evidenceReference ?? "No source document",
    synthetic: observation?.synthetic ?? false,
    pending: !observation,
  };
}

export function ClaimWorkbench({
  episode,
  preflight,
  events = [],
  agentMode = "synthetic",
  compactHeader = false,
}: {
  episode: EpisodeView;
  preflight?: PreflightCheck[] | null;
  events?: DomainEvent[];
  agentMode?: string;
  compactHeader?: boolean;
}) {
  const pms = latestObservation(episode, "pms");
  const remittance = latestObservation(episode, "remittance");
  const posting = latestObservation(episode, "posting");
  const lifecycle = [
    {
      label: "Encounter",
      raw: episode.encounterState,
      normalized: humanize(episode.encounterState),
      at: `${episode.dateOfService} 14:00 UTC`,
      evidence: `Encounter/encounter-${episode.id}`,
      synthetic: true,
      pending: false,
    },
    {
      label: "Claim",
      raw: episode.claimId ?? "No claim created",
      normalized: humanize(episode.chargeState),
      at: "Timestamp unavailable",
      evidence: episode.claimId ? `Claim/${episode.claimId.toLowerCase()}` : "No claim resource",
      synthetic: true,
      pending: !episode.claimId,
    },
    sourceStage("Clearinghouse", latestObservation(episode, "clearinghouse")),
    sourceStage("Payer", latestObservation(episode, "payer")),
    sourceStage("Remittance", remittance),
    sourceStage("Posting", posting),
  ];

  const statusLabel = BUCKET_LABELS[episode.primaryBucket] ?? humanize(episode.primaryBucket);

  return (
    <div className="workbench" data-testid={`workbench-${episode.id}`}>
      <section className={`panel workbench-summary ${compactHeader ? "workbench-summary-compact" : ""}`}>
        <div className="workbench-summary-main">
          <div>
            <span className="eyebrow">Claim episode</span>
            <h2>{episode.patientName}</h2>
            <p className="muted">
              {episode.claimId ?? "No claim yet"} · DOS {episode.dateOfService} · {episode.payerName}
            </p>
          </div>
          <div className="summary-status">
            <span className={`status-pill status-${episode.primaryBucket}`}>
              {statusLabel}
            </span>
            <small>Verified {episode.lastVerifiedAt}</small>
          </div>
        </div>

        <dl className="summary-facts">
          <div><dt>Provider</dt><dd>{episode.providerName}</dd></div>
          <div><dt>Service</dt><dd>{episode.cpt ?? "Not reported"}</dd></div>
          <div><dt>Billed</dt><dd>${episode.billedAmount.toFixed(2)}</dd></div>
          <div><dt>Owner</dt><dd>{episode.owner}</dd></div>
          <div><dt>Resolution</dt><dd>{humanize(episode.resolutionState)}</dd></div>
        </dl>

        <div className="meta-row summary-flags">
          {episode.verifiedPaid && <span className="badge badge-success">Verified paid</span>}
          {episode.overlays.includes("source_discrepancy") && (
            <span className="badge danger" data-testid="discrepancy-badge">Source discrepancy</span>
          )}
          {episode.overlays.includes("approval_required") && <span className="badge">Approval required</span>}
          {episode.overlays.includes("follow_up_due") && <span className="badge warn">Follow-up due</span>}
        </div>
      </section>

      <div className="workbench-layout">
        <div className="workbench-main">
          {episode.discrepancies.length > 0 ? (
            <section className="panel proof-panel discrepancy-proof" data-testid="discrepancy-panel">
              <header className="section-header compact">
                <div>
                  <span className="eyebrow eyebrow-danger">Source conflict</span>
                  <h2>PMS and payer disagree</h2>
                </div>
                <span className="badge danger">Newer payer truth</span>
              </header>
              {episode.discrepancies.map((finding) => (
                <div key={finding.ruleId} className="discrepancy-finding">
                  <p>{finding.summary}</p>
                  <div className="source-compare">
                    {finding.comparedSources.map((source) => (
                      <article key={`${source.source}-${source.observedAt}`}>
                        <span className="eyebrow">{humanize(source.source)}</span>
                        <strong>{humanize(source.normalizedStatus)}</strong>
                        <small>Observed {source.observedAt}</small>
                        <code>{source.evidenceReference}</code>
                      </article>
                    ))}
                  </div>
                  {finding.evidenceReferences.map((reference) => (
                    <span key={reference} className="evidence-reference">◆ {reference}</span>
                  ))}
                </div>
              ))}
            </section>
          ) : episode.verifiedPaid ? (
            <section className="panel proof-panel verified-proof">
              <header className="section-header compact">
                <div><span className="eyebrow eyebrow-success">Independent agreement</span><h2>Verified paid</h2></div>
                <span className="badge badge-success">Reconciled</span>
              </header>
              <p>
                Payment is verified only because remittance and the independent PMS posting agree.
                A payer portal status by itself is not enough.
              </p>
              <div className="paid-proof-grid">
                <article><span>Remittance</span><strong>{money(episode.financial.paid)}</strong><small>{remittance?.observedAt ?? "Timestamp unavailable"}</small><code>{remittance?.evidenceReference ?? "No evidence"}</code></article>
                <span className="proof-equals" aria-hidden>=</span>
                <article><span>PMS posting</span><strong>{money(episode.financial.posted)}</strong><small>{posting?.observedAt ?? "Timestamp unavailable"}</small><code>{posting?.evidenceReference ?? "No evidence"}</code></article>
              </div>
            </section>
          ) : preflight ? (
            <section className="panel proof-panel readiness-proof">
              <span className="eyebrow">Submission readiness</span>
              <h2>{preflight.every((check) => check.passed) ? "Ready for approval" : "Blocked before submission"}</h2>
              <p className="muted">The agent can prepare the action, but it cannot write externally without Allow once.</p>
            </section>
          ) : null}

          <section className="panel evidence-panel">
            <header className="section-header compact">
              <div><span className="eyebrow">Grounding</span><h2>Evidence drawer</h2></div>
              <span className="count-badge">{episode.evidence.length}</span>
            </header>
            <ul className="evidence-list" data-testid="evidence-drawer">
              {episode.evidence.map((item) => (
                <li key={item.id} id={`evidence-${item.id}`}>
                  <div className="evidence-heading">
                    <strong>{item.title}</strong>
                    {item.synthetic && <span className="badge warn">Synthetic</span>}
                  </div>
                  <div className="muted">{item.summary}</div>
                  <div className="evidence-meta"><span>{item.observedAt}</span><code>{item.reference}</code></div>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel lifecycle-panel">
            <header className="section-header compact">
              <div><span className="eyebrow">Multi-source state</span><h2>Claim lifecycle</h2></div>
              <span className="muted">Newest source wins</span>
            </header>
            {pms && (
              <div className="pms-callout" data-testid="pms-observation">
                <div><span className="eyebrow">PMS observation</span><strong>{humanize(pms.normalizedStatus)}</strong></div>
                <div><small>Observed {pms.observedAt}</small><code>{pms.evidenceReference}</code></div>
              </div>
            )}
            <ol className="lifecycle" data-testid="lifecycle">
              {lifecycle.map((stage, index) => (
                <li key={stage.label} className={`lifecycle-item ${stage.pending ? "lifecycle-pending" : ""}`}>
                  <span className="stage-marker" aria-hidden>{index + 1}</span>
                  <div className="stage-body">
                    <div className="stage-title"><strong>{stage.label}</strong><span>{stage.normalized}</span></div>
                    <div className="stage-details">
                      <span>Raw <code>{stage.raw}</code></span>
                      <span>Observed {stage.at}</span>
                      <span>Evidence <code>{stage.evidence}</code></span>
                      {stage.synthetic && <span className="badge warn">Synthetic</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="muted lifecycle-note">Order: {LIFECYCLE_ORDER.join(" → ")}. Submitted, accepted, and reprocessing requested are never treated as paid.</p>
          </section>

          <section className="panel financial-panel">
            <header className="section-header compact"><div><span className="eyebrow">Reconciliation</span><h2>Financials</h2></div></header>
            <div className="financial-grid" data-testid="financials">
              <div><span>Billed</span><strong>{money(episode.financial.billed)}</strong></div>
              <div><span>Allowed</span><strong>{money(episode.financial.allowed)}</strong></div>
              <div><span>Paid</span><strong>{money(episode.financial.paid)}</strong></div>
              <div><span>Posted</span><strong>{money(episode.financial.posted)}</strong></div>
              <div><span>Adjustment</span><strong>{money(episode.financial.adjustment)}</strong></div>
              <div><span>Patient responsibility</span><strong>{money(episode.financial.patientResponsibility)}</strong></div>
            </div>
          </section>
        </div>

        <AgentStation
          key={episode.id}
          episode={episode}
          preflight={preflight}
          events={events}
          agentMode={agentMode}
        />
      </div>
    </div>
  );
}
