import { assertPortalUrl } from "../browser.mjs";
import { NORTHSTAR_PORTAL_PASSWORD, NORTHSTAR_PORTAL_USERNAME } from "../allowlist.mjs";
import { computeConfirmationNumber } from "../confirmation.mjs";

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
  await page.goto(
    assertPortalUrl(`claims/${entry.claimId}/appeal?idempotencyKey=${encodeURIComponent(job.idempotencyKey)}`),
  );

  addProgress("reading");
  await page.click("button[type=submit]");
  await page.waitForSelector("#confirmationNumber");
  const scrapedConfirmationNumber = (await page.textContent("#confirmationNumber"))?.trim() || null;
  const proof = await saveScreenshot(await page.screenshot());

  addProgress("finalizing");
  const expectedConfirmationNumber = computeConfirmationNumber(entry.claimId, job.idempotencyKey);
  const isConfirmed = scrapedConfirmationNumber === expectedConfirmationNumber;

  return {
    state: isConfirmed ? "completed" : "pending_verification",
    result: {
      claimId: entry.claimId,
      confirmationNumber: scrapedConfirmationNumber,
      expectedConfirmationNumber,
      connectorReceipt: isConfirmed
        ? {
            confirmed: true,
            confirmationNumber: scrapedConfirmationNumber,
            payer: "Northstar Payer Services Demo",
          }
        : null,
      note: isConfirmed
        ? "Portal confirmation matches this request's idempotency key."
        : "Portal shows a confirmation number bound to a different idempotency key; treat this outcome as unverified until reconciled.",
      proofIds: [proof.proofId],
    },
  };
}
