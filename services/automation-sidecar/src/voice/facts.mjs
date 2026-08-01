// Deterministic, allowlisted fact extraction. Only these four fields are ever
// extracted from a transcript; anything else in the transcript is discarded.
// If a real (non-scripted) transcript does not contain a recognizable token,
// the corresponding fact is left null rather than guessed.

const CLAIM_REFERENCE_PATTERN = /\bCLM-EA-\d+\b/i;
const REASON_CODE_PATTERN = /\bCO-\d{3}\b/i;

export function extractAllowlistedFacts(transcript) {
  const text = typeof transcript === "string" ? transcript : "";
  const lower = text.toLowerCase();

  const claimReferenceMatch = text.match(CLAIM_REFERENCE_PATTERN);
  const reasonCodeMatch = text.match(REASON_CODE_PATTERN);

  const status = lower.includes("denied") ? "denied" : null;
  const nextStepMatch = text.match(/(resubmit[^.]*\.|respond[^.]*\.|within \d+ (calendar )?days[^.]*\.)/i);

  return {
    status,
    reasonCode: reasonCodeMatch ? reasonCodeMatch[0].toUpperCase() : null,
    claimReference: claimReferenceMatch ? claimReferenceMatch[0].toUpperCase() : null,
    nextStep: nextStepMatch ? nextStepMatch[0].trim() : null,
  };
}
