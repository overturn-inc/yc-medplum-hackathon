import type { ClaimEpisode } from "./types";

/** Actions that have deterministic proposal builders in this demo. */
export type ProposableActionType =
  | "submit_claim"
  | "request_reprocessing"
  | "correct_and_resubmit"
  | "send_documentation"
  | "submit_appeal";

const DEFAULT_ACTION_BY_FIXTURE: Partial<
  Record<ClaimEpisode["fixtureKey"], ProposableActionType>
> = {
  "encounter-a": "submit_claim",
  "claim-a": "submit_claim",
  "claim-c": "request_reprocessing",
  "claim-d": "correct_and_resubmit",
  "claim-e": "send_documentation",
};

/**
 * The guided hero claim (`encounter-a`) is the only fixture whose default
 * proposal action changes over time: it starts at `submit_claim`, then --
 * once the required connector receipts exist -- advances to
 * `request_reprocessing` and finally `submit_appeal`. This mirrors (but does
 * not replace) the authoritative gate in `assertActionAllowed`: this is only
 * a best-effort default guess for callers that did not pass an explicit
 * `action`, never itself a source of truth for what is allowed.
 */
function heroDefaultAction(episode: ClaimEpisode): ProposableActionType | null {
  if (episode.transportState === "unsent" && !episode.submissionReceiptId) {
    return "submit_claim";
  }
  if (
    episode.portalInvestigationReceiptId &&
    episode.voiceSessionReceiptId &&
    episode.adjudicationState === "denied" &&
    !episode.reprocessingReceiptId
  ) {
    return "request_reprocessing";
  }
  if (episode.denialUpheldReceiptId && !episode.appealReceiptId) {
    return "submit_appeal";
  }
  return null;
}

/**
 * Client-safe mapping with no Node-only dependencies. `episode` is optional
 * so existing call sites that only have a `fixtureKey` keep working; passing
 * the episode is required to get encounter-a's stage-aware default (see
 * `heroDefaultAction`) instead of its initial `submit_claim` default.
 */
export function defaultActionTypeForFixture(
  fixtureKey: ClaimEpisode["fixtureKey"],
  episode?: ClaimEpisode,
): ProposableActionType | null {
  if (fixtureKey === "encounter-a" && episode) {
    return heroDefaultAction(episode) ?? DEFAULT_ACTION_BY_FIXTURE[fixtureKey] ?? null;
  }
  return DEFAULT_ACTION_BY_FIXTURE[fixtureKey] ?? null;
}
