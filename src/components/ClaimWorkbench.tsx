import { ApprovalControls } from "@/components/ApprovalControls";
import type { EpisodeView } from "@/domain/projector";
import type { PreflightCheck } from "@/domain/preflight";
import type { DomainEvent } from "@/domain/types";

const LIFECYCLE_ORDER = [
  "Encounter",
  "Claim",
  "Clearinghouse",
  "Payer",
  "Remittance",
  "Posting",
] as const;

export function ClaimWorkbench({
  episode,
  preflight,
  events = [],
}: {
  episode: EpisodeView;
  preflight?: PreflightCheck[] | null;
  events?: DomainEvent[];
}) {
  const sourceBlocks = [
    {
      label: "Encounter",
      raw: episode.encounterState,
      normalized: episode.encounterState,
      at: `${episode.dateOfService}T14:00:00.000Z`,
      evidence: `Encounter/encounter-${episode.id}`,
    },
    {
      label: "Claim",
      raw: episode.claimId ?? "No claim",
      normalized: episode.chargeState,
      at: episode.lastVerifiedAt,
      evidence: episode.claimId ? `Claim/${episode.claimId.toLowerCase()}` : "—",
    },
    ...(["clearinghouse", "payer", "remittance", "posting"] as const).map((source) => {
      const obs = episode.observations
        .filter((o) => o.source === source)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      return {
        label: source[0]!.toUpperCase() + source.slice(1),
        raw: obs?.rawStatus ?? "—",
        normalized: obs?.normalizedStatus ?? "—",
        at: obs?.observedAt ?? "—",
        evidence: obs?.evidenceReference ?? "—",
        synthetic: obs?.synthetic,
      };
    }),
  ];

  // Ensure PMS observation is visible in lifecycle narrative
  const pms = episode.observations
    .filter((o) => o.source === "pms")
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];

  return (
    <div className="workbench" data-testid={`workbench-${episode.id}`}>
      <div className="stack">
        <section className="panel">
          <div className="meta-row">
            <span className="badge">{episode.patientName}</span>
            <span className="badge">{episode.payerName}</span>
            <span className="badge">${episode.billedAmount.toFixed(2)}</span>
            <span className="badge">{episode.primaryBucket}</span>
            <span className="badge">{episode.resolutionState}</span>
            <span className="badge">Verified {episode.lastVerifiedAt}</span>
            {episode.verifiedPaid && <span className="badge">Verified paid</span>}
            {episode.overlays.includes("source_discrepancy") && (
              <span className="badge danger" data-testid="discrepancy-badge">
                Source discrepancy
              </span>
            )}
          </div>
          <p className="muted">
            Provider {episode.providerName} · DOS {episode.dateOfService} · Owner{" "}
            {episode.owner}
          </p>
        </section>

        <section className="panel">
          <h2>Lifecycle</h2>
          <div className="lifecycle" data-testid="lifecycle">
            {sourceBlocks.map((block) => (
              <div key={block.label} className="lifecycle-item">
                <strong>{block.label}</strong>
                <div>
                  <div>
                    Raw: <span className="mono">{block.raw}</span>
                  </div>
                  <div>
                    Normalized: <span className="mono">{block.normalized}</span>
                  </div>
                  <div className="muted">Observed {block.at}</div>
                  <div className="muted">Evidence {block.evidence}</div>
                  {"synthetic" in block && block.synthetic ? (
                    <span className="badge warn">Synthetic</span>
                  ) : null}
                </div>
              </div>
            ))}
            {pms && (
              <div className="lifecycle-item" data-testid="pms-observation">
                <strong>PMS observation</strong>
                <div>
                  <div>
                    Raw: <span className="mono">{pms.rawStatus}</span>
                  </div>
                  <div>
                    Normalized: <span className="mono">{pms.normalizedStatus}</span>
                  </div>
                  <div className="muted">Observed {pms.observedAt}</div>
                  <div className="muted">Evidence {pms.evidenceReference}</div>
                  {pms.synthetic && <span className="badge warn">Synthetic</span>}
                </div>
              </div>
            )}
          </div>
          <p className="muted">
            Order: {LIFECYCLE_ORDER.join(" → ")}. Current Medplum Stedi path stores raw
            277/835 as DocumentReference and does not auto-create normalized adjudication
            ClaimResponse or PaymentReconciliation.
          </p>
        </section>

        <section className="panel">
          <h2>Financial reconciliation</h2>
          <div className="kpi-grid" data-testid="financials">
            <div className="kpi-card">
              <span>Billed</span>
              <strong>${episode.financial.billed.toFixed(2)}</strong>
            </div>
            <div className="kpi-card">
              <span>Allowed</span>
              <strong>
                {episode.financial.allowed == null
                  ? "—"
                  : `$${episode.financial.allowed.toFixed(2)}`}
              </strong>
            </div>
            <div className="kpi-card">
              <span>Paid</span>
              <strong>
                {episode.financial.paid == null
                  ? "—"
                  : `$${episode.financial.paid.toFixed(2)}`}
              </strong>
            </div>
            <div className="kpi-card">
              <span>Posted</span>
              <strong>
                {episode.financial.posted == null
                  ? "—"
                  : `$${episode.financial.posted.toFixed(2)}`}
              </strong>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Evidence drawer</h2>
          <ul className="evidence-list" data-testid="evidence-drawer">
            {episode.evidence.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <div className="muted">{item.summary}</div>
                <div className="mono">{item.reference}</div>
                {item.synthetic && <span className="badge warn">Synthetic</span>}
              </li>
            ))}
          </ul>
        </section>

        {episode.discrepancies.length > 0 && (
          <section className="panel" data-testid="discrepancy-panel">
            <h2>Discrepancy findings</h2>
            {episode.discrepancies.map((finding) => (
              <div key={finding.ruleId} className="stack">
                <strong>{finding.ruleId}</strong>
                <p>{finding.summary}</p>
                <ul className="funnel-list">
                  {finding.comparedSources.map((source) => (
                    <li key={`${source.source}-${source.observedAt}`}>
                      <span>
                        {source.source}: {source.normalizedStatus}
                      </span>
                      <span className="muted">{source.observedAt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>

      <aside className="panel agent-station" aria-label="Agent station">
        <h2>Agent station</h2>
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
          actionType={
            (episode.proposal?.actionType as
              | "submit_claim"
              | "request_reprocessing"
              | undefined) ??
            (episode.fixtureKey === "encounter-a"
              ? "submit_claim"
              : "request_reprocessing")
          }
          proposal={episode.proposal}
          preflight={preflight ?? null}
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
    </div>
  );
}
