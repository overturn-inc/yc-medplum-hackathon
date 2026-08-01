/**
 * Server-owned action policy.
 *
 * `ActionService.createProposal` / `decide` and the `/api/proposals` route
 * must never trust a client-supplied `actionType` on its own: the server is
 * the only party allowed to decide which action is legal for a given
 * episode's fixture and current state. `assertActionAllowed` is the single
 * gate every mutation-shaped call passes through before a proposal is built
 * or an approval is executed.
 */
import type { ActionType, ClaimEpisode } from "./types";
import { isVerifiedPaid } from "./verified-paid";

function deny(message: string, status: 400 | 409 = 409): never {
  throw Object.assign(new Error(message), { status });
}

/**
 * Throws (400/409) if `actionType` is not a server-permitted mutation for
 * `episode` given its fixture and current state. Never mutates anything;
 * callers must run this before building a proposal and again before
 * executing an approval.
 */
export function assertActionAllowed(
  episode: ClaimEpisode,
  actionType: ActionType,
): void {
  // Claim F / closed / verified-paid / reconciled episodes never accept
  // mutations of any kind, regardless of the requested actionType.
  if (
    episode.fixtureKey === "claim-f" ||
    episode.resolutionState === "closed" ||
    episode.postingState === "reconciled" ||
    isVerifiedPaid(episode)
  ) {
    deny(
      `No mutations are allowed on episode ${episode.id}: claim is closed, verified paid, or reconciled`,
      409,
    );
  }

  switch (episode.fixtureKey) {
    case "encounter-a": {
      if (actionType === "submit_claim") {
        if (episode.transportState !== "unsent" || episode.submissionReceiptId) {
          deny(
            "encounter-a submit_claim is only allowed while unsent with no submission receipt",
          );
        }
        return;
      }
      if (actionType === "request_reprocessing") {
        if (
          !episode.portalInvestigationReceiptId ||
          !episode.voiceSessionReceiptId ||
          episode.adjudicationState !== "denied" ||
          episode.reprocessingReceiptId
        ) {
          deny(
            "encounter-a request_reprocessing requires portal investigation and voice session " +
              "connector receipts, a denied adjudication, and no existing reprocessing receipt",
          );
        }
        return;
      }
      if (actionType === "submit_appeal") {
        if (
          !episode.denialUpheldReceiptId ||
          episode.appealReceiptId ||
          (episode.resolutionState !== "approval_required" &&
            episode.resolutionState !== "investigating")
        ) {
          deny(
            "encounter-a submit_appeal requires a denial-upheld connector receipt, no existing " +
              "appeal receipt, and resolution approval_required or investigating",
          );
        }
        return;
      }
      deny(
        `encounter-a only allows submit_claim, request_reprocessing, or submit_appeal; got ${actionType}`,
        400,
      );
      return;
    }
    case "claim-a": {
      if (actionType !== "submit_claim") {
        deny(`claim-a only allows submit_claim; got ${actionType}`, 400);
      }
      if (episode.transportState !== "unsent" || episode.submissionReceiptId) {
        deny(
          "claim-a submit_claim is only allowed while unsent with no submission receipt",
        );
      }
      return;
    }
    case "claim-b": {
      // Claim B is read-only w.r.t. proposal/approval-shaped actions: the
      // payer status refresh is a dedicated, non-approval read-check
      // (see ActionService.refreshPayerStatus), never a proposal.
      deny(
        "claim-b does not accept proposal-based or approval-gated actions; use the read-only payer status refresh",
        400,
      );
      return;
    }
    case "claim-c": {
      if (actionType !== "request_reprocessing") {
        deny(
          `claim-c only allows request_reprocessing; got ${actionType}`,
          400,
        );
      }
      if (episode.adjudicationState !== "denied" || episode.reprocessingReceiptId) {
        deny(
          "claim-c request_reprocessing is only allowed while denied with no reprocessing receipt",
        );
      }
      return;
    }
    case "claim-d": {
      if (actionType !== "correct_and_resubmit") {
        deny(
          `claim-d only allows correct_and_resubmit; got ${actionType}`,
          400,
        );
      }
      if (
        episode.transportState !== "clearinghouse_rejected" ||
        episode.correctedFromClaimId
      ) {
        deny(
          "claim-d correct_and_resubmit is only allowed while clearinghouse_rejected with no correctedFromClaimId",
        );
      }
      return;
    }
    case "claim-e": {
      if (actionType !== "send_documentation") {
        deny(
          `claim-e only allows send_documentation; got ${actionType}`,
          400,
        );
      }
      if (
        episode.adjudicationState !== "info_requested" ||
        episode.documentationReceiptId
      ) {
        deny(
          "claim-e send_documentation is only allowed while info_requested with no documentation receipt",
        );
      }
      return;
    }
    default: {
      // claim-f is already denied above; connected-claim / connected-encounter
      // have no server-scripted proposal action in this demo.
      deny(
        `No server-owned action policy permits mutations on fixture ${episode.fixtureKey}`,
        400,
      );
    }
  }
}

/** Non-throwing variant for callers that want a boolean check instead of a thrown error. */
export function isActionAllowed(
  episode: ClaimEpisode,
  actionType: ActionType,
): boolean {
  try {
    assertActionAllowed(episode, actionType);
    return true;
  } catch {
    return false;
  }
}
