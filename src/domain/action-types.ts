import type { ClaimEpisode } from "./types";

/** Actions that have deterministic proposal builders in this demo. */
export type ProposableActionType =
  | "submit_claim"
  | "request_reprocessing"
  | "correct_and_resubmit"
  | "send_documentation";

const DEFAULT_ACTION_BY_FIXTURE: Partial<
  Record<ClaimEpisode["fixtureKey"], ProposableActionType>
> = {
  "encounter-a": "submit_claim",
  "claim-a": "submit_claim",
  "claim-c": "request_reprocessing",
  "claim-d": "correct_and_resubmit",
  "claim-e": "send_documentation",
};

/** Client-safe mapping with no Node-only dependencies. */
export function defaultActionTypeForFixture(
  fixtureKey: ClaimEpisode["fixtureKey"],
): ProposableActionType | null {
  return DEFAULT_ACTION_BY_FIXTURE[fixtureKey] ?? null;
}
