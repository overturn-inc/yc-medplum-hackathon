"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StediEligibilityCheck } from "@/components/StediEligibilityCheck";
import { ToolJobPanel } from "@/components/ToolJobPanel";
import {
  HERO_STAGES,
  getHeroStageView,
  heroStageIndex,
  type HeroStage,
} from "@/domain/hero";
import type { EpisodeView } from "@/domain/projector";

const STAGE_LABELS: Record<HeroStage, string> = {
  visit_ready: "Visit",
  eligibility_checked: "Eligibility",
  claim_submitted: "Submitted",
  accepted_overdue: "Accepted",
  portal_denied: "Denied",
  voice_evidence_collected: "Voice evidence",
  reprocessing: "Reprocessing",
  denial_upheld: "Upheld",
  appeal_ready: "Appeal ready",
  appeal_submitted: "Appealed",
};

/**
 * Guided stepper + single adaptive CTA for the encounter-a hero claim.
 * Proposal-shaped actions (submit_claim, request_reprocessing, submit_appeal)
 * never duplicate `ApprovalControls`: this component either creates the
 * proposal or points to the existing Allow once control in the decision
 * panel. Only deterministic, connector-free hero transitions and tool jobs
 * are executed directly from here.
 */
export function HeroFlow({
  episode,
  stediConfigured,
}: {
  episode: EpisodeView;
  stediConfigured: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const heroView = getHeroStageView(episode);
  if (!heroView) return null;
  const currentIndex = heroStageIndex(heroView.stage);

  async function callHeroAction(action: "advance_follow_through" | "prepare_appeal") {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/episodes/${episode.id}/hero`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Hero action failed");
        return;
      }
      setMessage(
        action === "advance_follow_through"
          ? "Advanced to accepted overdue; no external write was made."
          : "Appeal packet prepared. Review it and use Allow once below to submit.",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Hero action failed");
    } finally {
      setBusy(false);
    }
  }

  async function proposeDefaultAction() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId: episode.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not create a proposal");
        return;
      }
      setMessage(`Proposal created: ${data.proposal?.title ?? "review below"}.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a proposal");
    } finally {
      setBusy(false);
    }
  }

  function renderPrimaryAction() {
    switch (heroView!.primaryAction) {
      case "check_eligibility":
        return <StediEligibilityCheck episodeId={episode.id} configured={stediConfigured} />;

      case "submit_claim":
      case "request_reprocessing": {
        if (episode.proposal?.actionType === heroView!.primaryAction) {
          return (
            <p className="pending-callout" role="status" data-testid="hero-await-approval">
              Proposal ready. Use <strong>Allow once</strong> in the decision panel below to
              continue.
            </p>
          );
        }
        return (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void proposeDefaultAction()}
            data-testid="hero-propose-action"
          >
            {busy ? "Preparing…" : heroView!.primaryLabel}
          </button>
        );
      }

      case "advance_follow_through":
        return (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void callHeroAction("advance_follow_through")}
            data-testid="hero-advance-follow-through"
          >
            {busy ? "Advancing…" : heroView!.primaryLabel}
          </button>
        );

      case "investigate_portal":
        return (
          <ToolJobPanel
            episodeId={episode.id}
            action="investigate_claim"
            label={heroView!.primaryLabel}
            onSettled={() => router.refresh()}
          />
        );

      case "start_voice_session":
        return (
          <ToolJobPanel
            episodeId={episode.id}
            action="voice_session"
            label={heroView!.primaryLabel}
            onSettled={() => router.refresh()}
          />
        );

      case "recheck_denial":
        return (
          <ToolJobPanel
            episodeId={episode.id}
            action="recheck_reprocessing"
            label={heroView!.primaryLabel}
            onSettled={() => router.refresh()}
          />
        );

      case "prepare_appeal":
        return (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void callHeroAction("prepare_appeal")}
            data-testid="hero-prepare-appeal"
          >
            {busy ? "Preparing…" : heroView!.primaryLabel}
          </button>
        );

      case "submit_appeal":
        return (
          <p className="pending-callout" role="status" data-testid="hero-await-approval">
            Appeal packet ready. Use <strong>Allow once</strong> in the decision panel below to
            submit.
          </p>
        );

      case "none":
        return (
          <p className="success-callout" role="status">
            {heroView!.description}
          </p>
        );

      default:
        return null;
    }
  }

  return (
    <section className="panel hero-flow" data-testid="hero-flow" aria-label="Guided hero claim flow">
      <header className="section-header compact">
        <div>
          <span className="eyebrow">Guided hero claim · CLM-EA-1001</span>
          <h2>{heroView.label}</h2>
        </div>
        <span className="badge">{`Step ${currentIndex + 1} of ${HERO_STAGES.length}`}</span>
      </header>

      <ol className="hero-stepper" aria-label="Hero claim stage progress">
        {HERO_STAGES.map((stage, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
          return (
            <li
              key={stage}
              className={`hero-step hero-step-${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="hero-step-marker" aria-hidden>
                {state === "done" ? "✓" : index + 1}
              </span>
              <span className="hero-step-label">{STAGE_LABELS[stage]}</span>
            </li>
          );
        })}
      </ol>

      <p className="muted">{heroView.description}</p>

      <div className="hero-cta" key={heroView.stage} data-testid="hero-primary-action">
        {renderPrimaryAction()}
      </div>

      <div aria-live="polite" className="sr-only">
        {message ?? error ?? ""}
      </div>
      {message && (
        <p className="success-callout" data-testid="hero-message">
          {message}
        </p>
      )}
      {error && (
        <p className="error-callout" role="alert" data-testid="hero-error">
          {error}
        </p>
      )}
    </section>
  );
}
