// Server-owned synthetic fixtures. Clients may only reference these records by
// episodeId (and optionally claimId, which must match exactly). No client input
// is ever used to construct a URL, selector, script, member, patient, or claim
// value that reaches the browser or the portal.

export const ACTIONS = Object.freeze([
  "investigate_claim",
  "recheck_reprocessing",
  "submit_appeal",
  "voice_session",
]);

export const EPISODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

export const NORTHSTAR_PORTAL_USERNAME = "demo.agent";
export const NORTHSTAR_PORTAL_PASSWORD = "northstar-demo-only";

export const EPISODE_ALLOWLIST = Object.freeze({
  "episode-encounter-a": Object.freeze({
    episodeId: "episode-encounter-a",
    claimId: "CLM-EA-1001",
    portalUsername: NORTHSTAR_PORTAL_USERNAME,
    portalPassword: NORTHSTAR_PORTAL_PASSWORD,
    denialReasonCode: "CO-197",
    denialReasonText: "Authorization required",
    onFileAuthNumber: "AUTH-EA-88213",
    appealNextStep: "Northstar will respond within 30 calendar days of receipt.",
  }),
});

/**
 * Resolves the fixed synthetic record for an episode, optionally verifying a
 * client-supplied claimId matches exactly. Returns null when the episodeId is
 * unknown or the claimId does not match the allowlisted value.
 */
export function resolveEpisode(episodeId, claimId) {
  if (typeof episodeId !== "string" || !EPISODE_ID_PATTERN.test(episodeId)) {
    return null;
  }
  const entry = EPISODE_ALLOWLIST[episodeId];
  if (!entry) return null;
  if (claimId !== undefined && claimId !== null && claimId !== entry.claimId) {
    return null;
  }
  return entry;
}
