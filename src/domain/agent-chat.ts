/**
 * Deterministic conversational agent for the claim workbench.
 *
 * Intent classification and answers are fully rule-based (no model calls):
 * this keeps the demo reproducible and lets every answer be traced back to
 * exact evidence/observation references on the current episode. Answers
 * NEVER cite evidence from any other episode.
 *
 * `request_action` intent never mutates healthcare state directly -- the
 * caller (`@/server/agent-chat`) is responsible for turning it into a
 * server-built `ActionService.createProposal` call that still requires an
 * explicit human "Allow once" before anything executes.
 */
import { runPreflight } from "./preflight";
import { defaultActionTypeForFixture, type ProposableActionType } from "./proposals";
import type { AgentIntent, ClaimEpisode, EvidenceItem, SourceObservation } from "./types";
import { isVerifiedPaid } from "./verified-paid";

export interface ChatCitation {
  reference: string;
  source: string;
  observedAt: string;
  title: string;
}

export interface ChatAnswer {
  intent: AgentIntent;
  content: string;
  citations: ChatCitation[];
  /** The action a "do it" / "go ahead" request would create a proposal for, or null if none is scripted. */
  suggestedActionType: ProposableActionType | null;
  /**
   * True only for claim-b's read-only payer status refresh: this
   * request_action turn should execute the non-approval refresh check
   * directly (see `ActionService.refreshPayerStatus`), never create a
   * proposal. Every other request_action turn creates a proposal only.
   */
  executeReadOnlyRefresh?: boolean;
}

const REQUEST_ACTION_PATTERNS: RegExp[] = [
  /\bdo it\b/,
  /\bgo ahead\b/,
  /\bplease\s+(submit|send|resubmit|reprocess|refresh|correct|fix)\b/,
  /\bsubmit\s+(it|this|that|the)?\s*claim\b/,
  /\bsubmit\s+(it|this|that)\b/,
  /\bsend\s+(it|this|that|the)?\s*documentation\b/,
  /\bsend\s+it\b/,
  /\byes[, ]+(submit|send|go)\b/,
  /\brefresh\b[\s\w]{0,25}\bstatus\b/,
  /\bcheck\b[\s\w]{0,25}\bstatus\b/,
  /\bresubmit\b/,
  /\bcorrect and resubmit\b/,
  /\bfix\b[\s\w]{0,25}\b(rejection|resubmit)\b/,
  /\bapprove\b/,
  /\bproceed\b/,
  /\brequest reprocessing\b/,
  /\breprocess\b/,
];

const REASON_PATTERNS: RegExp[] = [
  /\bwhy\b/,
  /\breason\b/,
  /\bexplain\b/,
  /\bwhat happened\b/,
  /\bdenial\b/,
  /\bis (this|it)\s+a\b/,
];

const EVIDENCE_PATTERNS: RegExp[] = [
  /\bevidence\b/,
  /\bproof\b/,
  /\bdocument(s|ation)?\b/,
  /\bsource\b/,
  /\bcitation/,
];

const STATUS_PATTERNS: RegExp[] = [
  /\bstatus\b/,
  /\bwhere\s+(is|are|do)\b/,
  /\bupdate\b/,
  /what.?s happening/,
];

const NEXT_ACTION_PATTERNS: RegExp[] = [
  /\bnext\b/,
  /\bwhat should\b/,
  /\brecommend/,
  /\bwhat now\b/,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Deterministic, phrase-based intent classification (no model calls). */
export function classifyIntent(rawText: string): AgentIntent {
  const text = rawText.toLowerCase().trim();
  if (!text) return "unsupported";
  if (matchesAny(REQUEST_ACTION_PATTERNS, text)) return "request_action";
  if (matchesAny(REASON_PATTERNS, text)) return "reason";
  if (matchesAny(EVIDENCE_PATTERNS, text)) return "evidence";
  if (matchesAny(NEXT_ACTION_PATTERNS, text)) return "next_action";
  if (matchesAny(STATUS_PATTERNS, text)) return "status";
  return "unsupported";
}

export const ACTION_LABELS: Record<ProposableActionType, string> = {
  submit_claim: "submit this claim",
  request_reprocessing: "request payer reprocessing",
  correct_and_resubmit: "correct and resubmit this claim",
  send_documentation: "send the requested documentation",
};

function citeEvidence(items: Array<EvidenceItem | undefined>): ChatCitation[] {
  return items
    .filter((item): item is EvidenceItem => !!item)
    .map((item) => ({
      reference: item.reference,
      source: item.kind,
      observedAt: item.observedAt,
      title: item.title,
    }));
}

function citeObservations(items: Array<SourceObservation | undefined>): ChatCitation[] {
  return items
    .filter((item): item is SourceObservation => !!item)
    .map((item) => ({
      reference: item.evidenceReference,
      source: item.source,
      observedAt: item.observedAt,
      title: `${item.source[0]!.toUpperCase()}${item.source.slice(1)}: ${item.rawStatus}`,
    }));
}

function latestBySource(
  episode: ClaimEpisode,
  source: SourceObservation["source"],
): SourceObservation | undefined {
  return [...episode.observations]
    .filter((o) => o.source === source)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

interface Responder {
  (episode: ClaimEpisode, intent: AgentIntent): { content: string; citations: ChatCitation[] };
}

/** Claim F: verified-paid explanation, no further action available. */
const respondClaimF: Responder = (episode, intent) => {
  const remittance = episode.evidence.find(
    (e) => e.kind === "raw_835" || e.kind === "era_pdf",
  );
  const posting = episode.evidence.find((e) => e.kind === "pms_posting");
  const citations = citeEvidence([remittance, posting]);

  if (intent === "evidence") {
    return {
      content:
        `Verified paid rests on two independent artifacts: the payer remittance ` +
        `(${remittance?.reference ?? "missing"}) and a separate PMS posting receipt ` +
        `(${posting?.reference ?? "missing"}), with matching claim/remittance control numbers ` +
        `(${episode.claimControlNumber}) and matching paid/posted amounts.`,
      citations,
    };
  }
  if (intent === "reason") {
    return {
      content:
        `This claim is verified paid because the ERA reports $${episode.financial.paid?.toFixed(2)} paid ` +
        `and the PMS posting receipt independently confirms $${episode.financial.posted?.toFixed(2)} posted ` +
        `against the same control number -- Claim.status or ClaimResponse.outcome alone are never used to infer payment.`,
      citations,
    };
  }
  const verifiedPaid = isVerifiedPaid(episode);
  return {
    content: verifiedPaid
      ? "This claim is verified paid and reconciled. No further action is needed."
      : "This claim is not yet verified paid: remittance and independent PMS posting evidence do not both check out.",
    citations,
  };
};

/** Claim C: discrepancy explanation citing the conflicting sources. */
const respondClaimC: Responder = (episode) => {
  const conflict = episode.discrepancies.find((d) => d.ruleId === "status_conflict");
  const authEvidence = episode.evidence.find((e) => e.kind === "authorization");
  const citations = [
    ...(conflict
      ? conflict.comparedSources.map((s) => ({
          reference: s.evidenceReference,
          source: s.source,
          observedAt: s.observedAt,
          title: `${s.source[0]!.toUpperCase()}${s.source.slice(1)}: ${s.normalizedStatus}`,
        }))
      : []),
    ...citeEvidence([authEvidence]),
  ];
  const content = conflict
    ? `PMS reports "${conflict.comparedSources[0]?.normalizedStatus}" while the payer reported ` +
      `"${conflict.comparedSources[1]?.normalizedStatus}" on ${conflict.comparedSources[1]?.observedAt}. ` +
      `This conflicts with on-file authorization evidence showing authorization is not required for this ` +
      `date of service and CPT code.`
    : (episode.issue ?? "No source discrepancy currently detected on this episode.");
  return { content, citations };
};

/** Claim D: distinguishes a clearinghouse rejection from a true payer denial. */
const respondClaimD: Responder = (episode) => {
  const rejection = episode.evidence.find((e) => e.kind === "raw_277");
  const correction = episode.evidence.find((e) => e.kind === "artifact");
  let content: string;
  if (episode.correctedFromClaimId) {
    content =
      `The original claim ${episode.correctedFromClaimId} was corrected and resubmitted as ` +
      `${episode.claimId}. Adjudication is still unconfirmed (not_found) -- this was a clearinghouse-level ` +
      `rejection before it ever reached the payer, not a payer denial.`;
  } else if (episode.transportState === "clearinghouse_rejected") {
    content =
      `This claim was rejected by the CLEARINGHOUSE before it ever reached the payer for adjudication ` +
      `-- it is not a payer denial. ${episode.issue ?? ""}`.trim();
  } else if (episode.adjudicationState === "denied") {
    content =
      "The payer received this claim and adjudicated it as denied. That is a true payer denial, " +
      "which is different from a clearinghouse rejection before adjudication.";
  } else {
    content = episode.issue ?? "Status update pending.";
  }
  return { content, citations: citeEvidence([rejection, correction]) };
};

/** Claim B: overdue status explanation citing the last payer/clearinghouse checks. */
const respondClaimB: Responder = (episode) => {
  const payer = latestBySource(episode, "payer");
  const clearinghouse = latestBySource(episode, "clearinghouse");
  const content = episode.nextFollowUpAt
    ? `Claim was accepted for processing but remittance is overdue: follow-up was due ` +
      `${episode.nextFollowUpAt} and the last payer check was ${episode.lastPayerCheckAt ?? "unknown"}, ` +
      `with no newer payer or remittance observation since.`
    : `Claim is accepted for processing; last payer check was ${episode.lastPayerCheckAt ?? "unknown"}.`;
  return { content, citations: citeObservations([payer, clearinghouse]) };
};

/** Claim E: identifies the signed supporting note already on file. */
const respondClaimE: Responder = (episode) => {
  const note = episode.evidence.find((e) => e.kind === "note");
  const pend = episode.evidence.find((e) => e.kind === "portal_snapshot");
  const content = note
    ? `The payer requested supporting documentation${pend ? ` (${pend.summary})` : ""}. ` +
      `A signed supporting note is already on file: ${note.reference}. It has not been sent to the payer yet.`
    : "No signed supporting note is on file yet for this documentation request.";
  return { content, citations: citeEvidence([note, pend]) };
};

/** Encounter A / Claim A: submission readiness against the preflight checklist. */
const respondSubmissionReadiness: Responder = (episode) => {
  const checks = runPreflight(episode);
  const failed = checks.filter((c) => !c.passed);
  const content =
    failed.length === 0
      ? "This is ready for claim submission: completed encounter, final note, active coverage, " +
        "provider, diagnosis, service line, and charge are all present."
      : `Not ready to submit yet: ${failed.map((c) => c.label).join(", ")} still pending.`;
  return { content, citations: citeEvidence(episode.evidence) };
};

const RESPONDERS: Partial<
  Record<ClaimEpisode["fixtureKey"], Responder>
> = {
  "encounter-a": respondSubmissionReadiness,
  "claim-a": respondSubmissionReadiness,
  "claim-b": respondClaimB,
  "claim-c": respondClaimC,
  "claim-d": respondClaimD,
  "claim-e": respondClaimE,
  "claim-f": respondClaimF,
};

const defaultResponder: Responder = (episode) => ({
  content: episode.issue ?? `Current resolution state: ${episode.resolutionState}.`,
  citations: citeEvidence(episode.evidence.slice(0, 3)),
});

/**
 * Grounds an already-classified intent against episode evidence. Used by both
 * the local classifier and the BFF conversation boundary so model output never
 * invents citations or mutates domain state.
 */
export function answerChatWithIntent(
  episode: ClaimEpisode,
  intent: AgentIntent,
): ChatAnswer {
  const suggestedActionType = defaultActionTypeForFixture(episode.fixtureKey);

  if (intent === "request_action") {
    if (episode.fixtureKey === "claim-b") {
      return {
        intent,
        content:
          "I can run a read-only payer status refresh now -- it only re-checks the payer portal and " +
          "appends a new status observation. It never needs Allow once and never marks the claim paid.",
        citations: [],
        suggestedActionType: null,
        executeReadOnlyRefresh: true,
      };
    }
    const content = suggestedActionType
      ? `I can create a proposal to ${ACTION_LABELS[suggestedActionType]}. I will never execute a ` +
        `healthcare write directly from chat -- you still need to review and Allow once on the ` +
        `resulting proposal before anything happens.`
      : "There is no scripted next action for this episode. Create a proposal manually with an explicit action type.";
    return { intent, content, citations: [], suggestedActionType };
  }

  const responder = RESPONDERS[episode.fixtureKey] ?? defaultResponder;
  const { content, citations } = responder(episode, intent);
  return { intent, content, citations, suggestedActionType };
}

/**
 * Answers a user chat message scoped to a single episode. Every citation is
 * drawn only from that episode's own evidence/observations/discrepancies.
 */
export function answerChatMessage(episode: ClaimEpisode, message: string): ChatAnswer {
  return answerChatWithIntent(episode, classifyIntent(message));
}
