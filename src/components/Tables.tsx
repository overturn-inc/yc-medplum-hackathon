"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";

type FilterOption = { id: string; label: string };

export function FilterChips({ options, value, onChange, label, counts }: {
  options: FilterOption[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  counts?: Record<string, number>;
}) {
  return (
    <div className="filters" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="filter-chip"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}{counts ? <small>{counts[option.id] ?? 0}</small> : null}
        </button>
      ))}
    </div>
  );
}

function containsFilter(filterKeys: string, filter: string) {
  return filter === "all" || String(filterKeys ?? "").split(",").includes(filter);
}

function formatDate(value: string | null) {
  return value ? value.slice(0, 10) : "—";
}

function humanBucket(bucket: string) {
  return ({
    needs_claim: "Needs claim",
    ready_to_submit: "Ready to submit",
    rejected_before_adjudication: "Rejected before adjudication",
    awaiting_payer: "Awaiting payer",
    action_required: "Action required",
    denied_under_resolution: "Denied — in resolution",
    paid_needs_posting: "Paid — needs posting",
    reconciled_or_closed: "Reconciled and closed",
  } as Record<string, string>)[bucket] ?? bucket.replaceAll("_", " ");
}

function statusTone(bucket: string) {
  if (bucket === "reconciled_or_closed") return "status-success";
  if (bucket === "denied_under_resolution") return "status-danger";
  if (bucket === "rejected_before_adjudication") return "status-rejected";
  if (bucket === "action_required") return "status-warning";
  if (bucket === "awaiting_payer") return "status-info";
  return "status-ready";
}

function statusSource(bucket: string) {
  if (bucket === "reconciled_or_closed") return "Posting";
  if (bucket === "rejected_before_adjudication") return "Clearinghouse";
  if (bucket === "denied_under_resolution" || bucket === "action_required" || bucket === "awaiting_payer") return "Payer";
  return "PMS";
}

type ClaimRow = {
  id: string;
  patientName: string;
  claimId: string | null;
  dateOfService: string;
  payerName: string;
  cpt: string | null;
  billedAmount: number;
  primaryBucket: string;
  pmsState: string;
  clearinghouseState: string;
  payerState: string;
  remittancePostingState: string;
  ageDays: number;
  lastPayerCheckAt: string | null;
  nextFollowUpAt: string | null;
  issue: string | null;
  agentAction: string | null;
  owner: string;
  filterKeys: string;
  overlays?: string[];
  verifiedPaid?: boolean;
};

const PRIMARY_FILTERS: FilterOption[] = [
  { id: "all", label: "All claims" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "ready_to_submit", label: "Ready to submit" },
  { id: "awaiting_payer", label: "Awaiting payer" },
  { id: "denied_under_resolution", label: "Denial resolution" },
  { id: "reconciled_or_closed", label: "Reconciled" },
];

const GROUPED_FILTERS = [
  { title: "Source state", options: [
    { id: "draft", label: "Draft" }, { id: "submitted", label: "Submitted" },
    { id: "rejected", label: "Rejected" }, { id: "accepted", label: "Accepted" },
    { id: "processing", label: "Processing" }, { id: "pended", label: "Pended" },
    { id: "denied", label: "Denied" }, { id: "paid", label: "Paid" },
  ]},
  { title: "Work queue", options: [
    { id: "needs_claim", label: "Needs claim" }, { id: "ready_to_submit", label: "Ready to submit" },
    { id: "rejected_before_adjudication", label: "Rejected queue" }, { id: "awaiting_payer", label: "Awaiting payer" },
    { id: "action_required", label: "Action required" }, { id: "denied_under_resolution", label: "Denial resolution" },
    { id: "paid_needs_posting", label: "Needs posting" }, { id: "reconciled_or_closed", label: "Reconciled" },
  ]},
  { title: "Flags", options: [
    { id: "needs_attention", label: "Needs attention" }, { id: "source_discrepancy", label: "Source discrepancy" },
    { id: "approval_required", label: "Needs approval" }, { id: "follow_up_due", label: "Follow-up due" },
  ]},
] as const;

function RowFlags({ row }: { row: ClaimRow }) {
  return (
    <span className="row-flags">
      {row.overlays?.includes("source_discrepancy") ? <span className="mini-flag mini-flag-warn">Source discrepancy</span> : null}
      {row.overlays?.includes("approval_required") ? <span className="mini-flag">Approval required</span> : null}
      {row.overlays?.includes("follow_up_due") ? <span className="mini-flag mini-flag-info">Follow-up due</span> : null}
      {row.verifiedPaid ? <span className="mini-flag mini-flag-success">Verified paid</span> : null}
    </span>
  );
}

export function ClaimsTable({ rows, initialFilter = "all" }: { rows: ClaimRow[]; initialFilter?: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState(initialFilter);
  const [expanded, setExpanded] = useState<string | null>(null);
  const allOptions = useMemo<FilterOption[]>(
    () => [
      ...PRIMARY_FILTERS,
      ...GROUPED_FILTERS.flatMap((group) => group.options as readonly FilterOption[]),
    ],
    [],
  );
  const counts = useMemo(
    () => ({
      ...Object.fromEntries(
        allOptions.map((option) => [
          option.id,
          rows.filter((row) => containsFilter(row.filterKeys, option.id)).length,
        ]),
      ),
      all: rows.length,
    }),
    [allOptions, rows],
  );
  const filtered = useMemo(() => rows.filter((row) => containsFilter(row.filterKeys, filter)), [filter, rows]);

  function changeFilter(next: string) {
    setFilter(next);
    window.history.replaceState(null, "", `/claims?filter=${next}`);
  }

  function openRow(id: string) {
    router.push(`/claims/${id}`);
  }

  return (
    <div className="stack claims-queue">
      <section className="filter-surface">
        <FilterChips label="Primary claim filters" options={PRIMARY_FILTERS} value={filter} onChange={changeFilter} counts={counts} />
      </section>
      <div className="filter-toolbar">
        <details className="more-filters">
          <summary className="btn">More filters</summary>
          <div className="filter-popover" role="dialog" aria-label="All claim filters">
            {GROUPED_FILTERS.map((group) => (
              <section key={group.title}>
                <strong>{group.title}</strong>
                <FilterChips label={group.title} options={[...group.options]} value={filter} onChange={changeFilter} counts={counts} />
              </section>
            ))}
            <p className="muted">Filters are single-select and deep-linkable.</p>
          </div>
        </details>
        <div className="queue-result-meta"><strong>{filtered.length}</strong> of {rows.length} claims <span className="mono">/claims?filter={filter}</span></div>
      </div>

      <div className="table-wrap claims-table-wrap">
        <table className="claims-table" data-testid="claims-table">
          <thead><tr>
            <th>Patient / claim</th><th>DOS</th><th>Payer</th><th>Billed</th><th>Status</th><th>Issue</th><th>Next action</th><th>Follow-up / age</th><th>Owner</th>
          </tr></thead>
          <tbody>
            {filtered.map((row) => (
              <Fragment key={row.id}>
                <tr
                  className="clickable-row"
                  tabIndex={0}
                  aria-label={`Open ${row.patientName} claim workbench`}
                  onClick={() => openRow(row.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRow(row.id); } }}
                >
                  <td><strong>{row.patientName}</strong><small className="mono">{row.claimId ?? "No claim yet"}</small></td>
                  <td>{row.dateOfService}</td>
                  <td>{row.payerName}</td>
                  <td className="money">${row.billedAmount.toFixed(2)}</td>
                  <td><span className={`status-pill ${statusTone(row.primaryBucket)}`}>{humanBucket(row.primaryBucket)}</span><small>Reported by {statusSource(row.primaryBucket)}</small><RowFlags row={row} /></td>
                  <td>{row.issue ?? "No exception"}</td>
                  <td><span>{row.agentAction ?? "No action available"}</span><small>{row.overlays?.includes("approval_required") ? "Needs Allow once" : "No approval needed"}</small></td>
                  <td><span>{formatDate(row.nextFollowUpAt)}</span><small>{row.ageDays} days old</small></td>
                  <td><span className="owner-avatar" aria-hidden>{row.owner.split(" ").map((part) => part[0]).join("")}</span>{row.owner}<button type="button" className="row-expand" aria-expanded={expanded === row.id} aria-label={`${expanded === row.id ? "Hide" : "Show"} claim attributes`} onClick={(event) => { event.stopPropagation(); setExpanded(expanded === row.id ? null : row.id); }}>Details</button></td>
                </tr>
                {expanded === row.id ? (
                  <tr key={`${row.id}-details`} className="expanded-row"><td colSpan={9}><dl className="attribute-grid">
                    <div><dt>Service line</dt><dd>{row.cpt ?? "Not reported"}</dd></div><div><dt>PMS</dt><dd>{row.pmsState}</dd></div><div><dt>Clearinghouse</dt><dd>{row.clearinghouseState}</dd></div><div><dt>Payer</dt><dd>{row.payerState}</dd></div><div><dt>Remittance / posting</dt><dd>{row.remittancePostingState}</dd></div><div><dt>Last payer check</dt><dd>{row.lastPayerCheckAt ?? "Not reported"}</dd></div>
                  </dl></td></tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="claim-cards" aria-label="Claims">
        {filtered.map((row) => (
          <article key={row.id} className="claim-card">
            <Link href={`/claims/${row.id}`} prefetch={false} aria-label={`Open ${row.patientName} claim workbench`}>
              <header><div><strong>{row.patientName}</strong><small className="mono">{row.claimId ?? "No claim yet"}</small></div><div className="money">${row.billedAmount.toFixed(2)}<small>billed</small></div></header>
              <div><span className={`status-pill ${statusTone(row.primaryBucket)}`}>{humanBucket(row.primaryBucket)}</span> <small>Reported by {statusSource(row.primaryBucket)}</small></div>
              <RowFlags row={row} />
              <p>{row.issue ?? "No exception — remittance and posting agree"}</p>
              <dl className="card-action-grid"><div><dt>Next action</dt><dd>{row.agentAction ?? "No action available"}</dd><small>{row.overlays?.includes("approval_required") ? "Needs Allow once" : "No approval needed"}</small></div><div><dt>Follow-up</dt><dd>{formatDate(row.nextFollowUpAt)}</dd><small>{row.ageDays} days old</small></div></dl>
              <footer><span className="owner-avatar" aria-hidden>{row.owner.split(" ").map((part) => part[0]).join("")}</span>{row.owner}<span>DOS {row.dateOfService} · {row.payerName}</span><span aria-hidden>›</span></footer>
            </Link>
            <button type="button" className="btn btn-quiet card-details" aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>{expanded === row.id ? "Hide" : "Show"} claim attributes</button>
            {expanded === row.id ? <dl className="attribute-grid mobile-attributes"><div><dt>Service line</dt><dd>{row.cpt ?? "Not reported"}</dd></div><div><dt>PMS</dt><dd>{row.pmsState}</dd></div><div><dt>Clearinghouse</dt><dd>{row.clearinghouseState}</dd></div><div><dt>Payer</dt><dd>{row.payerState}</dd></div><div><dt>Remittance / posting</dt><dd>{row.remittancePostingState}</dd></div></dl> : null}
          </article>
        ))}
      </div>

      <section className="claims-truth-grid">
        <div><strong>Rejection and denial are not the same thing</strong><p><span className="status-pill status-rejected">Rejected before adjudication</span> Clearinghouse stopped the claim before the payer saw it.</p><p><span className="status-pill status-danger">Denied — in resolution</span> Payer adjudicated and refused payment; evidence can dispute it.</p></div>
        <div><strong>Verified paid has a higher bar</strong><p>Greta Mills is verified only because the $152.00 remittance and independent $152.00 PMS posting agree. A payer portal status alone is insufficient.</p></div>
      </section>
    </div>
  );
}

type EncounterRow = {
  id: string; fixtureKey: string; patientName: string; dateOfService: string; providerName: string;
  coverageActive: boolean; encounterState: string; noteState: string; codingReady: boolean;
  billedAmount: number; chargeState: string; filterKeys: string;
};

export function EncountersTable({ rows }: { rows: EncounterRow[] }) {
  const [filter, setFilter] = useState("all");
  const options = [
    { id: "all", label: "All" }, { id: "ready_to_bill", label: "Ready to bill" },
    { id: "missing_information", label: "Missing information" }, { id: "claim_created", label: "Claim created" },
  ];
  const counts = Object.fromEntries(options.map((option) => [option.id, option.id === "all" ? rows.length : rows.filter((row) => containsFilter(row.filterKeys, option.id)).length]));
  const filtered = useMemo(() => rows.filter((row) => containsFilter(row.filterKeys, filter)), [filter, rows]);

  return (
    <div className="stack encounter-queue">
      <FilterChips label="Encounter filters" options={options} value={filter} onChange={setFilter} counts={counts} />
      <div className="table-wrap encounter-table-wrap">
        <table className="encounter-table" data-testid="encounters-table">
          <thead><tr><th>Patient</th><th>DOS</th><th>Provider</th><th>Coverage</th><th>Note</th><th>Coding</th><th>Charge</th><th>Billing state</th></tr></thead>
          <tbody>{filtered.map((row) => (
            <tr key={row.id} className={row.fixtureKey === "encounter-a" ? "selected-row" : ""}>
              <td><Link href={row.fixtureKey === "encounter-a" ? `/encounters?focus=${row.id}` : `/claims/${row.id}`} prefetch={false}><strong>{row.patientName}</strong><small>{row.fixtureKey === "encounter-a" ? "Selected · note signed" : "Note signed"}</small></Link></td>
              <td>{row.dateOfService}</td><td>{row.providerName}</td><td>{row.coverageActive ? "Active" : "Inactive"}</td><td>{row.noteState === "final" ? "Signed, final" : "Draft"}</td><td>{row.codingReady ? "Ready" : "Blocked"}</td><td className="money">${row.billedAmount.toFixed(2)}</td><td><span className={`status-pill ${row.chargeState === "ready" ? "status-ready" : "status-neutral"}`}>{row.chargeState === "ready" ? "Ready to bill" : "Claim created"}</span></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
