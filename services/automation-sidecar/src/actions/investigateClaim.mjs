import { assertPortalUrl } from "../browser.mjs";
import { NORTHSTAR_PORTAL_PASSWORD, NORTHSTAR_PORTAL_USERNAME } from "../allowlist.mjs";

export const needsBrowser = true;

export async function run(job, { page, entry, addProgress, saveScreenshot }) {
  addProgress("navigating");
  await page.goto(assertPortalUrl("login"));

  addProgress("authenticating");
  await page.fill("#username", NORTHSTAR_PORTAL_USERNAME);
  await page.fill("#password", NORTHSTAR_PORTAL_PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(assertPortalUrl("claims"));

  addProgress("typing");
  await page.fill("#claimId", entry.claimId);
  await page.click("button[type=submit]");
  await page.waitForURL(assertPortalUrl(`claims/${entry.claimId}`));

  addProgress("reading");
  const denialReasonText = (await page.textContent("body")) || "";
  const proof = await saveScreenshot(await page.screenshot());

  addProgress("finalizing");
  return {
    state: "completed",
    result: {
      claimId: entry.claimId,
      denialReasonCode: entry.denialReasonCode,
      denialReasonText: entry.denialReasonText,
      onFileAuthNumber: entry.onFileAuthNumber,
      conflict: `Denial reason "${entry.denialReasonText}" conflicts with on-file authorization ${entry.onFileAuthNumber}.`,
      portalContainsExpectedText: denialReasonText.includes(entry.denialReasonText),
      proofIds: [proof.proofId],
    },
  };
}
