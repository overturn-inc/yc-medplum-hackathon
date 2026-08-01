import type { ClaimEpisode, OverlayFlag, PrimaryBucket } from "./types";
import { ageInDays, selectOverlays, selectPrimaryBucket } from "./selectors";
import { isVerifiedPaid } from "./verified-paid";
import { getDemoClock, isAfter } from "./clock";
import { evaluateDiscrepancies } from "./discrepancy";

export interface EpisodeView extends ClaimEpisode {
  primaryBucket: PrimaryBucket;
  overlays: OverlayFlag[];
  ageDays: number;
  verifiedPaid: boolean;
  pmsState: string;
  clearinghouseState: string;
  payerState: string;
  remittancePostingState: string;
}

export interface DashboardKpi {
  visitsToday: number;
  visitsThisMonth: number;
  readyToSubmit: number;
  submittedOrInFlight: number;
  awaitingPayer: number;
  needsAttention: number;
  verifiedPaidMtd: number;
  funnel: Record<PrimaryBucket, number>;
  overlays: Record<OverlayFlag, number>;
}

export interface QueueRow {
  episodeId: string;
  patientName: string;
  title: string;
  issue: string;
  href: string;
  kind: "approval" | "exception";
}

function latestStatus(
  episode: ClaimEpisode,
  source: "pms" | "clearinghouse" | "payer" | "remittance" | "posting",
): string {
  const obs = episode.observations
    .filter((o) => o.source === source)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  return obs?.rawStatus ?? "—";
}

export function enrichEpisode(
  episode: ClaimEpisode,
  now = getDemoClock(),
): EpisodeView {
  const withDiscrepancies: ClaimEpisode = {
    ...episode,
    discrepancies: evaluateDiscrepancies(episode, now),
  };
  return {
    ...withDiscrepancies,
    primaryBucket: selectPrimaryBucket(withDiscrepancies),
    overlays: selectOverlays(withDiscrepancies, now),
    ageDays: ageInDays(withDiscrepancies, now),
    verifiedPaid: isVerifiedPaid(withDiscrepancies),
    pmsState: latestStatus(withDiscrepancies, "pms"),
    clearinghouseState: latestStatus(withDiscrepancies, "clearinghouse"),
    payerState: latestStatus(withDiscrepancies, "payer"),
    remittancePostingState: `${withDiscrepancies.remittanceState}/${withDiscrepancies.postingState}`,
  };
}

export function projectEpisodes(
  episodes: ClaimEpisode[],
  now = getDemoClock(),
): EpisodeView[] {
  return episodes.map((e) => enrichEpisode(e, now));
}

export function isNeedsAttention(view: EpisodeView): boolean {
  return (
    view.primaryBucket === "action_required" ||
    view.primaryBucket === "denied_under_resolution" ||
    view.primaryBucket === "rejected_before_adjudication" ||
    view.overlays.includes("source_discrepancy")
  );
}

export function computeDashboardKpi(
  episodes: ClaimEpisode[],
  now = getDemoClock(),
): DashboardKpi {
  const views = projectEpisodes(episodes, now);
  const funnel: Record<PrimaryBucket, number> = {
    needs_claim: 0,
    ready_to_submit: 0,
    rejected_before_adjudication: 0,
    awaiting_payer: 0,
    action_required: 0,
    denied_under_resolution: 0,
    paid_needs_posting: 0,
    reconciled_or_closed: 0,
  };
  const overlays: Record<OverlayFlag, number> = {
    follow_up_due: 0,
    source_discrepancy: 0,
    approval_required: 0,
  };

  for (const view of views) {
    funnel[view.primaryBucket] += 1;
    for (const flag of view.overlays) {
      overlays[flag] += 1;
    }
  }

  const monthPrefix = now.slice(0, 7);
  const dayPrefix = now.slice(0, 10);

  const visitsToday = episodes.filter((e) => e.dateOfService === dayPrefix).length;
  const visitsThisMonth = episodes.filter((e) =>
    e.dateOfService.startsWith(monthPrefix),
  ).length;

  const submittedOrInFlight = views.filter(
    (v) =>
      !!v.submissionReceiptId ||
      v.transportState === "sent" ||
      v.transportState === "clearinghouse_received" ||
      v.transportState === "payer_delivered",
  ).length;

  const awaitingPayer = funnel.awaiting_payer;
  const needsAttention = views.filter(isNeedsAttention).length;

  const verifiedPaidMtd = views.filter(
    (v) => v.verifiedPaid && v.dateOfService.startsWith(monthPrefix),
  ).length;

  return {
    visitsToday,
    visitsThisMonth,
    readyToSubmit: funnel.ready_to_submit,
    submittedOrInFlight,
    awaitingPayer,
    needsAttention,
    verifiedPaidMtd,
    funnel,
    overlays,
  };
}

export function buildQueues(
  episodes: ClaimEpisode[],
  now = getDemoClock(),
): { approvals: QueueRow[]; exceptions: QueueRow[] } {
  const views = projectEpisodes(episodes, now);
  const approvals: QueueRow[] = [];
  const exceptions: QueueRow[] = [];

  for (const view of views) {
    if (view.proposal && view.resolutionState === "approval_required") {
      approvals.push({
        episodeId: view.id,
        patientName: view.patientName,
        title: view.proposal.title,
        issue: view.issue ?? view.proposal.whatIFound,
        href:
          view.fixtureKey === "encounter-a"
            ? `/encounters?focus=${view.id}`
            : `/claims/${view.id}`,
        kind: "approval",
      });
    }

    if (view.overlays.includes("source_discrepancy")) {
      exceptions.push({
        episodeId: view.id,
        patientName: view.patientName,
        title: "Source discrepancy",
        issue: view.issue ?? "PMS and payer status conflict",
        href: `/claims/${view.id}`,
        kind: "exception",
      });
    } else if (view.overlays.includes("follow_up_due")) {
      exceptions.push({
        episodeId: view.id,
        patientName: view.patientName,
        title: "Follow-up due",
        issue: view.issue ?? `Follow-up was due ${view.nextFollowUpAt}`,
        href: `/claims/${view.id}`,
        kind: "exception",
      });
    } else if (
      view.primaryBucket === "rejected_before_adjudication" ||
      view.primaryBucket === "action_required" ||
      view.adjudicationState === "info_requested"
    ) {
      exceptions.push({
        episodeId: view.id,
        patientName: view.patientName,
        title: view.issue ?? "Exception",
        issue: view.issue ?? view.primaryBucket,
        href: `/claims/${view.id}`,
        kind: "exception",
      });
    }
  }

  return { approvals, exceptions };
}

export function isFollowUpDue(episode: ClaimEpisode, now = getDemoClock()): boolean {
  return !!episode.nextFollowUpAt && isAfter(now, episode.nextFollowUpAt);
}
