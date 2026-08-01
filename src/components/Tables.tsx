"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export function FilterChips({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
  label: string;
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
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function useFilterState(initial = "all") {
  const [filter, setFilter] = useState(initial);
  return { filter, setFilter };
}

export function ClaimsTable({
  rows,
  initialFilter = "all",
}: {
  rows: Array<{
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
  }>;
  initialFilter?: string;
}) {
  const { filter, setFilter } = useFilterState(initialFilter);
  const options = [
    { id: "all", label: "All" },
    { id: "draft", label: "Draft" },
    { id: "submitted", label: "Submitted" },
    { id: "rejected", label: "Rejected" },
    { id: "accepted", label: "Accepted" },
    { id: "processing", label: "Processing" },
    { id: "pended", label: "Pended" },
    { id: "denied", label: "Denied" },
    { id: "paid", label: "Paid" },
    { id: "needs_attention", label: "Needs attention" },
    { id: "needs_claim", label: "Needs claim" },
    { id: "ready_to_submit", label: "Ready to submit" },
    { id: "rejected_before_adjudication", label: "Rejected queue" },
    { id: "awaiting_payer", label: "Awaiting payer" },
    { id: "action_required", label: "Action required" },
    { id: "denied_under_resolution", label: "Denial resolution" },
    { id: "paid_needs_posting", label: "Needs posting" },
    { id: "reconciled_or_closed", label: "Reconciled" },
    { id: "source_discrepancy", label: "Discrepancy" },
    { id: "approval_required", label: "Needs approval" },
    { id: "follow_up_due", label: "Follow-up due" },
  ];

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((row) => String(row.filterKeys ?? "").includes(filter));
  }, [filter, rows]);

  return (
    <div className="stack">
      <FilterChips
        label="Claim filters"
        options={options}
        value={filter}
        onChange={setFilter}
      />
      <div className="table-wrap">
        <table data-testid="claims-table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Claim ID</th>
              <th>DOS</th>
              <th>Payer</th>
              <th>CPT</th>
              <th>Billed</th>
              <th>Primary bucket</th>
              <th>PMS</th>
              <th>Clearinghouse</th>
              <th>Payer</th>
              <th>Remit / Post</th>
              <th>Age</th>
              <th>Last payer check</th>
              <th>Next follow-up</th>
              <th>Issue</th>
              <th>Agent action</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={String(row.id)}>
                <td>
                  <Link href={`/claims/${row.id}`}>{row.patientName}</Link>
                </td>
                <td>{row.claimId ?? "—"}</td>
                <td>{row.dateOfService}</td>
                <td>{row.payerName}</td>
                <td>{row.cpt ?? "—"}</td>
                <td>${Number(row.billedAmount).toFixed(2)}</td>
                <td>{row.primaryBucket}</td>
                <td>{row.pmsState}</td>
                <td>{row.clearinghouseState}</td>
                <td>{row.payerState}</td>
                <td>{row.remittancePostingState}</td>
                <td>{row.ageDays}</td>
                <td>{row.lastPayerCheckAt ?? "—"}</td>
                <td>{row.nextFollowUpAt ?? "—"}</td>
                <td>{row.issue ?? "—"}</td>
                <td>{row.agentAction ?? "—"}</td>
                <td>{row.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EncountersTable({
  rows,
}: {
  rows: Array<{
    id: string;
    fixtureKey: string;
    patientName: string;
    dateOfService: string;
    providerName: string;
    coverageActive: boolean;
    encounterState: string;
    noteState: string;
    codingReady: boolean;
    billedAmount: number;
    chargeState: string;
    filterKeys: string;
  }>;
}) {
  const { filter, setFilter } = useFilterState();
  const options = [
    { id: "all", label: "All" },
    { id: "ready_to_bill", label: "Ready to bill" },
    { id: "missing_information", label: "Missing information" },
    { id: "claim_created", label: "Claim created" },
  ];
  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((row) => String(row.filterKeys ?? "").includes(filter));
  }, [filter, rows]);

  return (
    <div className="stack">
      <FilterChips
        label="Encounter filters"
        options={options}
        value={filter}
        onChange={setFilter}
      />
      <div className="table-wrap">
        <table data-testid="encounters-table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>DOS</th>
              <th>Provider</th>
              <th>Coverage</th>
              <th>Encounter</th>
              <th>Note</th>
              <th>Coding</th>
              <th>Charge</th>
              <th>Billing</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={String(row.id)}>
                <td>
                  {row.fixtureKey === "encounter-a" ? (
                    <Link href={`/encounters?focus=${row.id}`}>{row.patientName}</Link>
                  ) : (
                    <Link href={`/claims/${row.id}`}>{row.patientName}</Link>
                  )}
                </td>
                <td>{row.dateOfService}</td>
                <td>{row.providerName}</td>
                <td>{row.coverageActive ? "Active" : "Inactive"}</td>
                <td>{row.encounterState}</td>
                <td>{row.noteState}</td>
                <td>{row.codingReady ? "Ready" : "Blocked"}</td>
                <td>${Number(row.billedAmount).toFixed(2)}</td>
                <td>{row.chargeState}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
