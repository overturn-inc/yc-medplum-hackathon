import { createHash } from "node:crypto";

/**
 * Deterministic fictional Northstar appeal confirmation number derived only
 * from the claimId and the caller's idempotencyKey. The same pair always
 * produces the same confirmation number, which lets the portal and the
 * browser action independently agree on whether an outcome is genuinely
 * confirmed or merely ambiguous (see submitAppeal.mjs).
 */
export function computeConfirmationNumber(claimId, idempotencyKey) {
  const digest = createHash("sha256")
    .update(`${claimId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `NS-APL-${digest}`;
}
