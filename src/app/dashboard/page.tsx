import Link from "next/link";
import { getDemoViewModel } from "@/server/demo";
import { storeFromCookies } from "@/server/request-store";

export const dynamic = "force-dynamic";

const FUNNEL_LABELS: Record<string, string> = {
  needs_claim: "Needs claim",
  ready_to_submit: "Ready to submit",
  rejected_before_adjudication: "Rejected before adjudication",
  awaiting_payer: "Awaiting payer",
  action_required: "Action required",
  denied_under_resolution: "Denied under resolution",
  paid_needs_posting: "Paid needs posting",
  reconciled_or_closed: "Reconciled or closed",
};

const OVERLAY_LABELS: Record<string, string> = {
  follow_up_due: "Follow-up due",
  source_discrepancy: "Source discrepancy",
  approval_required: "Approval required",
};

const KPI = [
  { key: "visitsToday", label: "Visits today", detail: "2026-07-15", href: "/encounters", testId: "kpi-visits-today", tone: "neutral" },
  { key: "visitsThisMonth", label: "Visits this month", detail: "July 2026", href: "/encounters", testId: "kpi-visits-month", tone: "neutral" },
  { key: "readyToSubmit", label: "Ready to submit", detail: "Needs approval", href: "/claims?filter=ready_to_submit", testId: "kpi-ready", tone: "teal" },
  { key: "submittedOrInFlight", label: "Submitted or in flight", detail: "Not paid", href: "/claims?filter=submitted", testId: "kpi-submitted", tone: "blue" },
  { key: "awaitingPayer", label: "Awaiting payer", detail: "Remittance overdue", href: "/claims?filter=awaiting_payer", testId: "kpi-awaiting", tone: "blue" },
  { key: "needsAttention", label: "Needs attention", detail: "Work these first", href: "/claims?filter=needs_attention", testId: "kpi-attention", tone: "red" },
  { key: "verifiedPaidMtd", label: "Verified paid MTD", detail: "Remittance + posting", href: "/claims?filter=reconciled_or_closed", testId: "kpi-verified-paid", tone: "green" },
] as const;

export default async function DashboardPage() {
  const store = await storeFromCookies();
  const model = await getDemoViewModel(store);
  if (!model.ok) return null;

  const { kpi, queues, episodes } = model;
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  const funnelTotal = Object.values(kpi.funnel).reduce((sum, value) => sum + value, 0);

  return (
    <main className="page dashboard-page" data-testid="dashboard-page">
      <header className="page-header">
        <div>
          <h1>Practice overview</h1>
          <p>Wednesday 15 July 2026 · Harborview Family Medicine · synthetic fixture data</p>
        </div>
        <span className="demo-state"><span aria-hidden className="status-dot" /> Demo ready</span>
      </header>

      <section className="kpi-grid kpi-grid-seven" aria-label="Visit and operations KPI">
        {KPI.map((item) => (
          <Link
            key={item.key}
            className={`kpi-card kpi-${item.tone}`}
            href={item.href}
            prefetch={false}
            data-testid={item.testId}
          >
            <span>{item.label}</span>
            <strong>{kpi[item.key]}</strong>
            <small>{item.detail}</small>
          </Link>
        ))}
      </section>

      <section className="operations-grid">
        <div className="operations-stack">
          <section className="panel queue-panel queue-approval">
            <header className="section-header">
              <div>
                <h2><span aria-hidden>◎</span> Waiting on your approval</h2>
                <p>Nothing is written until you choose Allow once</p>
              </div>
              <span className="count-badge">{queues.approvals.length}</span>
            </header>
            <ul className="queue-list" data-testid="approvals-queue">
              {queues.approvals.map((row) => {
                const episode = byId.get(row.episodeId);
                return (
                  <li key={row.episodeId}>
                    <Link href={row.href} prefetch={false}>
                      <span className="queue-person">
                        <strong>{row.patientName}</strong>
                        <small className="mono">{episode?.claimId ?? "No claim yet"}</small>
                      </span>
                      <span className="queue-action">
                        <strong>{row.title}</strong>
                        <small>{row.issue}</small>
                      </span>
                      <span className="queue-state"><span>◎ Needs Allow once</span><small>{episode?.ageDays ?? 0} days old</small></span>
                      <span aria-hidden className="queue-chevron">›</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel queue-panel queue-exception">
            <header className="section-header">
              <div>
                <h2><span aria-hidden>!</span> Exceptions and follow-up</h2>
                <p>Read-only review · investigate before taking action</p>
              </div>
              <span className="count-badge count-warn">{queues.exceptions.length}</span>
            </header>
            <ul className="queue-list" data-testid="exceptions-queue">
              {queues.exceptions.map((row) => {
                const episode = byId.get(row.episodeId);
                return (
                  <li key={`${row.episodeId}-${row.title}`}>
                    <Link href={row.href} prefetch={false}>
                      <span className="queue-person">
                        <strong>{row.patientName}</strong>
                        <small className="mono">{episode?.claimId ?? "No claim"}</small>
                      </span>
                      <span className="queue-action">
                        <strong>{row.issue}</strong>
                        <small>Next: {episode?.agentAction ?? row.title}</small>
                      </span>
                      <span className="queue-state queue-state-warn"><span>{row.title}</span><small>{episode?.ageDays ?? 0} days old</small></span>
                      <span aria-hidden className="queue-chevron">›</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <aside className="operations-summary">
          <section className="panel funnel-panel">
            <header className="section-header compact">
              <div><h2>Claim funnel</h2><p>{funnelTotal} claims · one bucket each</p></div>
            </header>
            <div className="funnel-bar" aria-hidden>
              {Object.entries(kpi.funnel).map(([key, value]) => value > 0 ? (
                <span key={key} className={`funnel-segment segment-${key}`} style={{ flex: value }} />
              ) : null)}
            </div>
            <ul className="funnel-list" data-testid="funnel-list">
              {Object.entries(kpi.funnel).map(([key, value]) => (
                <li key={key} className={value === 0 ? "is-zero" : ""}>
                  {value === 0 ? <div><span>{FUNNEL_LABELS[key] ?? key}</span><strong data-testid={`funnel-${key}`}>{value}</strong></div> : (
                    <Link href={`/claims?filter=${key}`} prefetch={false}><span>{FUNNEL_LABELS[key] ?? key}</span><strong data-testid={`funnel-${key}`}>{value}</strong></Link>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel overlay-panel">
            <header className="section-header compact"><div><h2>Overlay flags</h2><p>Can overlap buckets</p></div></header>
            <ul className="overlay-list" data-testid="overlay-list">
              {Object.entries(kpi.overlays).map(([key, value]) => (
                <li key={key}>
                  <Link href={`/claims?filter=${key}`} prefetch={false}>
                    <span>{OVERLAY_LABELS[key] ?? key}</span>
                    <strong data-testid={`overlay-${key}`}>{value}</strong>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="boundary-note">
            <strong>What this demo does not do</strong>
            <ul>
              <li>No live payer, clearinghouse, or Medplum writes.</li>
              <li>Submitted, accepted, and reprocessing requested never mean paid.</li>
              <li>Every external action needs a proposal plus Allow once.</li>
            </ul>
          </section>
        </aside>
      </section>
    </main>
  );
}
