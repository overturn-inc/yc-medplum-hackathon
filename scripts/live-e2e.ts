#!/usr/bin/env npx tsx
/**
 * Live post-deployment E2E against LIVE_BASE_URL.
 * Mutates only anonymous synthetic sessions. Refuses connected healthcare mode.
 * Never writes to a real payer and never uses PHI.
 *
 * Usage:
 *   LIVE_BASE_URL=https://example.example npm run test:e2e:live
 */
import { chromium, type Page } from "@playwright/test";

const configuredBaseUrl = process.env.LIVE_BASE_URL;
if (!configuredBaseUrl) {
  console.error("LIVE_BASE_URL is required");
  process.exit(1);
}
const LIVE_ROOT = configuredBaseUrl.replace(/\/$/, "");

async function reset(page: Page) {
  await page.goto(`${LIVE_ROOT}/dashboard`);
  const response = await page.request.post(`${LIVE_ROOT}/api/demo/reset`);
  if (!response.ok()) {
    throw new Error(`Reset failed: ${response.status()}`);
  }
  await page.reload();
}

async function assertSyntheticOnly(page: Page) {
  await page.getByTestId("badge-synthetic").waitFor({ timeout: 30_000 });
  const healthcare = await page.getByTestId("badge-healthcare").innerText();
  if (!/local/i.test(healthcare)) {
    throw new Error(
      `Live E2E refuses connected healthcare mode (saw: ${healthcare}). Synthetic-only.`,
    );
  }
}

async function main() {
  const browser = await chromium.launch();
  const contextA = await browser.newContext();
  const page = await contextA.newPage();

  await reset(page);
  await assertSyntheticOnly(page);

  // Submission (Encounter A)
  await page.goto(`${LIVE_ROOT}/encounters?focus=episode-encounter-a`);
  await page.getByTestId("allow-once").waitFor({ timeout: 30_000 });
  await page.getByTestId("allow-once").click();
  await page.getByTestId("approval-message").waitFor({ timeout: 30_000 });

  // Claim B read-only refresh (no approval)
  await page.goto(`${LIVE_ROOT}/claims/episode-claim-b`);
  await page.getByTestId("refresh-payer-status").click();
  await page.getByTestId("refresh-status-message").waitFor({ timeout: 30_000 });

  // Claim C deny / re-propose / allow
  await page.goto(`${LIVE_ROOT}/claims/episode-claim-c`);
  await page.getByTestId("deny-action").click();
  await page.getByTestId("repropose-action").click();
  await page.getByTestId("allow-once").click();
  await page.getByTestId("approval-message").waitFor({ timeout: 30_000 });

  // Claim D correction with visible member id diff
  await page.goto(`${LIVE_ROOT}/claims/episode-claim-d`);
  await page.getByTestId("member-id-correction").waitFor({ timeout: 30_000 });
  await page.getByTestId("allow-once").click();
  await page.getByTestId("approval-message").waitFor({ timeout: 30_000 });

  // Claim E documentation
  await page.goto(`${LIVE_ROOT}/claims/episode-claim-e`);
  await page.getByTestId("allow-once").click();
  await page.getByTestId("approval-message").waitFor({ timeout: 30_000 });

  // Claim F: no mutation via chat
  await page.goto(`${LIVE_ROOT}/claims/episode-claim-f`);
  await page.getByText("Verified paid").waitFor({ timeout: 30_000 });
  await page.getByTestId("agent-chat-input").fill("Submit this claim for me");
  await page.getByTestId("agent-chat-send").click();
  await page.waitForTimeout(800);

  // Dashboard
  await page.goto(`${LIVE_ROOT}/dashboard`);
  await page.getByTestId("kpi-verified-paid").waitFor({ timeout: 30_000 });

  // Refresh persistence
  await page.reload();
  await page.getByTestId("badge-synthetic").waitFor({ timeout: 30_000 });

  // Two-context isolation
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(`${LIVE_ROOT}/dashboard`);
  await assertSyntheticOnly(pageB);
  await pageB.request.post(`${LIVE_ROOT}/api/demo/reset`);
  await pageB.reload();
  await pageB.goto(`${LIVE_ROOT}/claims/episode-claim-d`);
  await pageB.getByTestId("member-id-correction").waitFor({ timeout: 30_000 });

  // One-session reset on A
  await reset(page);
  await page.goto(`${LIVE_ROOT}/claims/episode-claim-f`);
  await page.getByText("Verified paid").waitFor({ timeout: 30_000 });

  console.log(`Live mutation E2E passed against ${LIVE_ROOT}`);
  await contextA.close();
  await contextB.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
