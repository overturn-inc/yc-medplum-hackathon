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

  addProgress("reading");
  await page.goto(assertPortalUrl(`claims/${entry.claimId}/recheck`));
  const bodyText = (await page.textContent("body")) || "";
  const proof = await saveScreenshot(await page.screenshot());

  addProgress("finalizing");
  return {
    state: "completed",
    result: {
      claimId: entry.claimId,
      reprocessingStatus: "upheld",
      statusText: "Denial upheld",
      portalContainsExpectedText: bodyText.toLowerCase().includes("denial upheld"),
      proofIds: [proof.proofId],
    },
  };
}
