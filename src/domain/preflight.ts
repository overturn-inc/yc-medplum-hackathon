import type { ClaimEpisode } from "./types";

export interface PreflightCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export function runPreflight(episode: ClaimEpisode): PreflightCheck[] {
  return [
    {
      id: "encounter_completed",
      label: "Completed encounter",
      passed:
        episode.encounterState === "completed" ||
        episode.encounterState === "note_signed",
      detail: `Encounter state: ${episode.encounterState}`,
    },
    {
      id: "final_note",
      label: "Final note",
      passed: episode.noteState === "final",
      detail: `Note state: ${episode.noteState}`,
    },
    {
      id: "active_coverage",
      label: "Active coverage",
      passed: episode.coverageActive,
      detail: episode.coverageActive
        ? `Coverage active with ${episode.payerName}`
        : "Coverage inactive or missing",
    },
    {
      id: "provider",
      label: "Provider",
      passed: !!episode.providerName,
      detail: episode.providerName || "Provider missing",
    },
    {
      id: "diagnosis",
      label: "Diagnosis",
      passed: episode.diagnoses.length > 0,
      detail:
        episode.diagnoses.map((d) => `${d.code} ${d.display}`).join(", ") ||
        "No diagnosis",
    },
    {
      id: "service_line",
      label: "Service line",
      passed: episode.serviceLines.length > 0,
      detail:
        episode.serviceLines.map((s) => `${s.cpt} x${s.units}`).join(", ") ||
        "No service lines",
    },
    {
      id: "charge",
      label: "Charge",
      passed:
        (episode.chargeState === "ready" ||
          episode.chargeState === "claim_created") &&
        episode.billedAmount > 0,
      detail: `Charge state: ${episode.chargeState}, billed $${episode.billedAmount.toFixed(2)}`,
    },
  ];
}

export function preflightReady(checks: PreflightCheck[]): boolean {
  return checks.every((c) => c.passed);
}
