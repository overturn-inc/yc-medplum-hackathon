import { expect, test } from "@playwright/test";

/**
 * These tests require AGENT_MODE=bff on the Playwright webServer.
 * They run in the `bff-chromium` project (see playwright.config.ts).
 */
test.describe("BFF agent mode E2E", () => {
  test("shows BFF badge and fails chat visibly without synthetic fallback", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("badge-agent")).toContainText("bff");
    await page.request.post("/api/demo/reset");
    await page.goto("/claims/episode-claim-c");
    await expect(page.getByTestId("agent-mode-badge")).toContainText("BFF");
    await page.getByTestId("agent-chat-input").fill("Why was this denied?");
    await page.getByTestId("agent-chat-send").click();
    await expect(page.getByTestId("chat-error")).toBeVisible({ timeout: 20_000 });
  });
});
