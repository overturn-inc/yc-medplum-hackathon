"use client";

import { useState } from "react";

interface EligibilityResult {
  checkId: string;
  applicationMode: string;
  activeCoverage: boolean;
  activeBenefitCount: number;
  planNames: string[];
  error?: string;
}
export function StediEligibilityCheck({
  episodeId,
  configured,
}: {
  episodeId: string;
  configured: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EligibilityResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runCheck() {
    if (busy || !configured) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/episodes/${episodeId}/eligibility`, {
        method: "POST",
      });
      const data = (await response.json()) as EligibilityResult;
      if (!response.ok) {
        setError(data.error ?? "Stedi eligibility check failed.");
        return;
      }
      setResult(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Stedi eligibility check failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stedi-check" data-testid="stedi-eligibility-check">
      <div>
        <span className="eyebrow">Live clearinghouse rail</span>
        <strong>Stedi 270/271 eligibility</strong>
        <small>Synthetic Jane Doe test record · no real PHI</small>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!configured || busy}
        onClick={runCheck}
        data-testid="stedi-eligibility-run"
      >
        {busy ? "Checking…" : configured ? "Verify with Stedi" : "Stedi not configured"}
      </button>
      {result && (
        <div className="stedi-result success-callout" role="status">
          <strong>{result.activeCoverage ? "Active coverage returned" : "No active coverage"}</strong>
          <span>
            Live API · {result.applicationMode} · {result.activeBenefitCount} active benefits
            {result.planNames.length ? ` · ${result.planNames.join(", ")}` : ""}
          </span>
          <code>{result.checkId}</code>
        </div>
      )}
      {error && <p className="error-callout" role="alert">{error}</p>}
    </div>
  );
}
