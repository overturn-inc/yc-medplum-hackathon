import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { LocalEventStore } from "@/server/store";
import { ActionService } from "@/server/actions";
import { ToolJobService } from "@/server/tool-jobs";
import {
  resetRateLimitWindowsForTests,
  resetToolJobLedgers,
} from "@/server/tool-job-ledger";
import { proposalApprovalFields } from "@/domain/approval";
import type { ClientApprovalScope } from "@/domain/approval";
import { deriveHeroStage } from "@/domain/hero";

const EPISODE_ID = "episode-encounter-a";

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-hero-appeal-"));
  return new LocalEventStore({ dataDir, healthcareMode: "local", agentMode: "synthetic" });
}

function scopeFor(store: LocalEventStore, episodeId: string): ClientApprovalScope {
  const episode = store.getEpisode(episodeId)!;
  expect(episode.proposal).toBeTruthy();
  return proposalApprovalFields(episode.proposal!);
}

beforeEach(() => {
  resetToolJobLedgers();
  resetRateLimitWindowsForTests();
});

describe("Guided hero claim: full visit -> appeal walk-through (encounter-a)", () => {
  it("advances through every hero stage via durable connector receipts and approval-gated actions only", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const toolJobs = new ToolJobService(store);

    // 1. Eligibility check is durable evidence, never the raw 271, and is
    // idempotent once recorded.
    const eligibility = await actions.recordEligibilityCheck(EPISODE_ID, {
      checkId: "check-1",
      applicationMode: "test",
      activeCoverage: true,
      activeBenefitCount: 2,
      planNames: ["Synthetic PPO"],
      hasRaw271: false,
    });
    expect(eligibility.idempotent).toBeFalsy();
    expect(eligibility.receiptId).toBeTruthy();
    let episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.eligibilityReceiptId).toBe(eligibility.receiptId);
    expect(episode.eligibilitySummary?.activeCoverage).toBe(true);
    expect(deriveHeroStage(episode)).toBe("eligibility_checked");

    const eligibilityAgain = await actions.recordEligibilityCheck(EPISODE_ID, {
      checkId: "check-2",
      applicationMode: "test",
      activeCoverage: false,
      activeBenefitCount: 0,
      planNames: [],
      hasRaw271: false,
    });
    expect(eligibilityAgain.idempotent).toBe(true);
    expect(eligibilityAgain.receiptId).toBe(eligibility.receiptId);
    expect(store.getEpisode(EPISODE_ID)!.eligibilitySummary?.activeCoverage).toBe(true);

    // 2. The eligibility check above bumped the episode revision, so any
    // proposal built before it is now stale; build a fresh submit_claim
    // proposal (mirrors HeroFlow.tsx's proposeDefaultAction) and Allow once
    // to submit via the simulated Stedi clearinghouse rail.
    await actions.createProposal(EPISODE_ID, "submit_claim");
    const submit = await actions.decide({
      episodeId: EPISODE_ID,
      actionType: "submit_claim",
      decision: "allow_once",
      scope: scopeFor(store, EPISODE_ID),
    });
    expect(submit.receiptId).toBeTruthy();
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.claimId).toBe("CLM-EA-1001");
    expect(episode.heroStage).toBe("claim_submitted");
    expect(deriveHeroStage(episode)).toBe("claim_submitted");

    // 3. Deterministic, connector-free follow-through: claim_submitted -> accepted_overdue.
    await expect(toolJobs.create({ episodeId: EPISODE_ID, action: "investigate_claim" })).rejects.toMatchObject(
      { status: 409 },
    );
    const followThrough = await actions.advanceHeroFollowThrough(EPISODE_ID);
    expect(followThrough.heroStage).toBe("accepted_overdue");
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.adjudicationState).toBe("accepted_for_processing");
    expect(episode.remittanceState).toBe("expected");
    expect(deriveHeroStage(episode)).toBe("accepted_overdue");

    await expect(actions.advanceHeroFollowThrough(EPISODE_ID)).rejects.toMatchObject({ status: 409 });

    // 4. Portal investigation tool job: accepted_overdue -> portal_denied.
    const portalJob = await toolJobs.create({
      episodeId: EPISODE_ID,
      action: "investigate_claim",
    });
    expect(portalJob.job.status).toBe("completed");
    expect(portalJob.job.connectorReceipt!.evidenceReference).toBe(
      "ConnectorReceipt/investigate_claim-episode-encounter-a",
    );
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.portalInvestigationReceiptId).toBe(portalJob.job.connectorReceipt!.id);
    expect(episode.adjudicationState).toBe("denied");
    expect(deriveHeroStage(episode)).toBe("portal_denied");

    // request_reprocessing is not allowed yet: voice evidence is still missing.
    await expect(
      actions.createProposal(EPISODE_ID, "request_reprocessing"),
    ).rejects.toMatchObject({ status: 409 });

    // 5. Voice session tool job: portal_denied -> voice_evidence_collected.
    const voiceJob = await toolJobs.create({ episodeId: EPISODE_ID, action: "voice_session" });
    expect(voiceJob.job.status).toBe("completed");
    expect(typeof voiceJob.job.result?.transcript).toBe("string");
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.voiceSessionReceiptId).toBe(voiceJob.job.connectorReceipt!.id);
    expect(deriveHeroStage(episode)).toBe("voice_evidence_collected");

    // 6. Approval-gated reprocessing proposal: voice_evidence_collected -> reprocessing.
    const reprocessProposal = await actions.createProposal(EPISODE_ID, "request_reprocessing");
    expect(reprocessProposal.proposal.actionType).toBe("request_reprocessing");
    const reprocessDecision = await actions.decide({
      episodeId: EPISODE_ID,
      actionType: "request_reprocessing",
      decision: "allow_once",
      scope: scopeFor(store, EPISODE_ID),
    });
    expect(reprocessDecision.receiptId).toBeTruthy();
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.reprocessingReceiptId).toBe(reprocessDecision.receiptId);
    expect(episode.resolutionState).toBe("reprocessing");
    expect(deriveHeroStage(episode)).toBe("reprocessing");

    // recheck_reprocessing tool job requires the reprocessing receipt (already present here).
    // 7. Recheck denial tool job: reprocessing -> denial_upheld.
    const recheckJob = await toolJobs.create({
      episodeId: EPISODE_ID,
      action: "recheck_reprocessing",
    });
    expect(recheckJob.job.status).toBe("completed");
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.denialUpheldReceiptId).toBe(recheckJob.job.connectorReceipt!.id);
    expect(episode.resolutionState).toBe("approval_required");
    expect(deriveHeroStage(episode)).toBe("denial_upheld");

    // submit_appeal is denied via the generic create() entry point: it is approval-gated only.
    await expect(
      toolJobs.create({ episodeId: EPISODE_ID, action: "submit_appeal" }),
    ).rejects.toMatchObject({ status: 403 });

    // 8. prepare_appeal creates the submit_appeal proposal: denial_upheld -> appeal_ready.
    const prepareAppeal = await actions.createProposal(EPISODE_ID, "submit_appeal");
    expect(prepareAppeal.proposal.actionType).toBe("submit_appeal");
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.heroStage).toBe("appeal_ready");
    expect(deriveHeroStage(episode)).toBe("appeal_ready");
    expect(
      store
        .getSnapshot()
        .events.some(
          (e) => e.type === "hero.stage.advanced" && "toStage" in e && e.toStage === "appeal_ready",
        ),
    ).toBe(true);

    // 9. Allow once for submit_appeal starts a browser tool job internally and
    // finalizes with a Northstar confirmation in the same turn (mock sidecar).
    const appealScope = scopeFor(store, EPISODE_ID);
    const appealDecision = await actions.decide({
      episodeId: EPISODE_ID,
      actionType: "submit_appeal",
      decision: "allow_once",
      scope: appealScope,
    });
    expect(appealDecision.receiptId).toBeTruthy();
    episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.appealReceiptId).toBe(appealDecision.receiptId);
    expect(episode.appealConfirmationNumber).toMatch(/^NS-APL-/);
    expect(episode.resolutionState).toBe("appealed");
    expect(episode.heroStage).toBe("appeal_submitted");
    expect(deriveHeroStage(episode)).toBe("appeal_submitted");
    expect(
      episode.fhirResources?.some(
        (r) => (r as { resourceType?: string }).resourceType === "Provenance",
      ),
    ).toBe(true);
    expect(
      episode.fhirResources?.some(
        (r) => (r as { resourceType?: string }).resourceType === "AuditEvent",
      ),
    ).toBe(true);

    // 10. Retrying the identical approval scope is idempotent: same receipt, no
    // second appeal submission, and no further episode mutation.
    const revisionAfterAppeal = store.getEpisode(EPISODE_ID)!.revision;
    const retry = await actions.decide({
      episodeId: EPISODE_ID,
      actionType: "submit_appeal",
      decision: "allow_once",
      scope: appealScope,
    });
    expect("idempotent" in retry && retry.idempotent).toBe(true);
    expect(retry.receiptId).toBe(appealDecision.receiptId);
    expect(store.getEpisode(EPISODE_ID)!.revision).toBe(revisionAfterAppeal);
    expect(
      store.getSnapshot().events.filter((e) => e.type === "appeal.submitted"),
    ).toHaveLength(1);
  });

  it("denies request_reprocessing and submit_appeal proposals before their connector receipts exist", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    await expect(
      actions.createProposal(EPISODE_ID, "request_reprocessing"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      actions.createProposal(EPISODE_ID, "submit_appeal"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("denying the submit_appeal proposal leaves no appeal receipt and clears approval_required", async () => {
    const store = tempStore();
    const actions = new ActionService(store);
    const toolJobs = new ToolJobService(store);

    await actions.decide({
      episodeId: EPISODE_ID,
      actionType: "submit_claim",
      decision: "allow_once",
      scope: scopeFor(store, EPISODE_ID),
    });
    await actions.advanceHeroFollowThrough(EPISODE_ID);
    await toolJobs.create({ episodeId: EPISODE_ID, action: "investigate_claim" });
    await toolJobs.create({ episodeId: EPISODE_ID, action: "voice_session" });
    await actions.createProposal(EPISODE_ID, "request_reprocessing");
    await actions.decide({
      episodeId: EPISODE_ID,
      actionType: "request_reprocessing",
      decision: "allow_once",
      scope: scopeFor(store, EPISODE_ID),
    });
    await toolJobs.create({ episodeId: EPISODE_ID, action: "recheck_reprocessing" });
    await actions.createProposal(EPISODE_ID, "submit_appeal");

    const denyResult = await actions.decide({
      episodeId: EPISODE_ID,
      actionType: "submit_appeal",
      decision: "deny",
      scope: scopeFor(store, EPISODE_ID),
    });
    expect("denied" in denyResult && denyResult.denied).toBe(true);

    const episode = store.getEpisode(EPISODE_ID)!;
    expect(episode.proposal).toBeNull();
    expect(episode.appealReceiptId).toBeFalsy();
    expect(episode.resolutionState).toBe("investigating");
  });
});
