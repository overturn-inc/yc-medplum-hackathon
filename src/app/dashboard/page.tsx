import Link from "next/link";
import { getDemoViewModel } from "@/server/demo";

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

export default async function DashboardPage() {
  const model = await getDemoViewModel();
  if (!model.ok) return null;

  const { kpi, queues } = model;

  return (
    <main className="page" data-testid="dashboard-page">
      <header className="page-header">
        <h1>Practice overview</h1>
        <p>
          Fixture-derived KPI and exception queues. Primary funnel is mutually exclusive;
          overlays can overlap.
        </p>
      </header>

      <section className="kpi-grid" aria-label="Visit and operations KPI">
        <Link className="kpi-card" href="/encounters" data-testid="kpi-visits-today">
          <span>Visits today</span>
          <strong>{kpi.visitsToday}</strong>
        </Link>
        <Link className="kpi-card" href="/encounters" data-testid="kpi-visits-month">
          <span>Visits this month</span>
          <strong>{kpi.visitsThisMonth}</strong>
        </Link>
        <Link
          className="kpi-card"
          href="/claims?filter=ready_to_submit"
          data-testid="kpi-ready"
        >
          <span>Ready to submit</span>
          <strong>{kpi.readyToSubmit}</strong>
        </Link>
        <Link
          className="kpi-card"
          href="/claims?filter=submitted"
          data-testid="kpi-submitted"
        >
          <span>Submitted or in flight</span>
          <strong>{kpi.submittedOrInFlight}</strong>
        </Link>
        <Link
          className="kpi-card"
          href="/claims?filter=awaiting_payer"
          data-testid="kpi-awaiting"
        >
          <span>Awaiting payer</span>
          <strong>{kpi.awaitingPayer}</strong>
        </Link>
        <Link
          className="kpi-card"
          href="/claims?filter=needs_attention"
          data-testid="kpi-attention"
        >
          <span>Needs attention</span>
          <strong>{kpi.needsAttention}</strong>
        </Link>
        <Link className="kpi-card" href="/claims?filter=reconciled_or_closed" data-testid="kpi-verified-paid">
          <span>Verified paid MTD</span>
          <strong>{kpi.verifiedPaidMtd}</strong>
        </Link>
      </section>

      <section className="funnel-grid">
        <div className="panel">
          <h2>Claim funnel</h2>
          <ul className="funnel-list" data-testid="funnel-list">
            {Object.entries(kpi.funnel).map(([key, value]) => (
              <li key={key}>
                <Link href={`/claims?filter=${key}`}>{FUNNEL_LABELS[key] ?? key}</Link>
                <strong data-testid={`funnel-${key}`}>{value}</strong>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>Overlay flags</h2>
          <ul className="funnel-list" data-testid="overlay-list">
            {Object.entries(kpi.overlays).map(([key, value]) => (
              <li key={key}>
                <Link href={`/claims?filter=${key}`}>{OVERLAY_LABELS[key] ?? key}</Link>
                <strong data-testid={`overlay-${key}`}>{value}</strong>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="queue-grid">
        <div className="panel">
          <h2>Agent approvals</h2>
          <ul className="queue-list" data-testid="approvals-queue">
            {queues.approvals.map((row) => (
              <li key={row.episodeId}>
                <Link href={row.href}>
                  <span>
                    {row.patientName}: {row.title}
                  </span>
                  <span className="muted">{row.issue}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>Exceptions and follow-up</h2>
          <ul className="queue-list" data-testid="exceptions-queue">
            {queues.exceptions.map((row) => (
              <li key={`${row.episodeId}-${row.title}`}>
                <Link href={row.href}>
                  <span>
                    {row.patientName}: {row.title}
                  </span>
                  <span className="muted">{row.issue}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
