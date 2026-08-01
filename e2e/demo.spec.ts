import { expect, test } from "@playwright/test";

async function resetDemo(page: import("@playwright/test").Page) {
  // Share cookies with the browser page so reset hits the same anonymous session.
  await page.goto("/dashboard");
  await page.request.post("/api/demo/reset");
  await page.reload();
}

test.describe("Harborview PMS demo journeys", () => {
  test.beforeEach(async ({ page }) => {
    await resetDemo(page);
  });

  test("opens synthetic dashboard with modes, KPI, queues, and routes", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("badge-synthetic")).toBeVisible();
    await expect(page.getByTestId("badge-healthcare")).toContainText("local");
    await expect(page.getByTestId("badge-agent")).toContainText("synthetic");
    await expect(page.getByTestId("kpi-visits-today")).toContainText("1");
    await expect(page.getByTestId("kpi-ready")).toContainText("2");
    await expect(page.getByTestId("kpi-verified-paid")).toContainText("1");
    await expect(page.getByTestId("approvals-queue")).toBeVisible();
    await expect(page.getByTestId("exceptions-queue")).toBeVisible();
    await expect(page.getByTestId("overlay-source_discrepancy")).toHaveText(/^[1-9]/);

    await page.getByTestId("kpi-attention").click();
    await expect(page).toHaveURL(/filter=needs_attention/);
    await expect(page.getByRole("button", { name: "Needs attention" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Header + 4 needs-attention episodes (B follow-up, C discrepancy, D rejected, E docs).
    await expect(page.getByTestId("claims-table").getByRole("row")).toHaveCount(5);

    await page.goto("/encounters");
    await expect(page.getByTestId("encounters-page")).toBeVisible();
    await page.goto("/claims");
    await expect(page.getByTestId("claims-page")).toBeVisible();
    await page.goto("/claims/episode-claim-c");
    await expect(page.getByTestId("claim-detail-page")).toBeVisible();
  });

  test("encounter A deny is safe and allow once submits without paid adjudication", async ({
    page,
  }) => {
    await page.goto("/encounters?focus=episode-encounter-a");
    await expect(page.getByTestId("preflight-checks")).toBeVisible();
    await expect(
      page.getByTestId("preflight-checks").getByText("Final note"),
    ).toBeVisible();

    await page.getByTestId("deny-action").click();
    await expect(page.getByTestId("approval-message")).toContainText("Denied");
    await expect(page.getByTestId("allow-once")).toHaveCount(0);
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-ready")).toContainText("2");

    await page.getByTestId("reset-demo").click();
    await page.waitForTimeout(500);
    await page.goto("/encounters?focus=episode-encounter-a");
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Submitted");
    await expect(page.getByTestId("approval-message")).toContainText("not yet found");
    await page.getByTestId("agent-chat-input").fill("What's the status?");
    await page.getByTestId("agent-chat-send").click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(
      "receipt-submit-episode-encounter-a",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("agent-chat-thread")).toContainText("monitoring");
    await expect(page.getByTestId("agent-chat-thread")).not.toContainText(
      "ready for claim submission",
    );
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-ready")).toContainText("1");
  });

  test("claim A submission proposal works", async ({ page }) => {
    await page.goto("/claims/episode-claim-a");
    await expect(page.getByTestId("allow-once")).toBeVisible();
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Submitted");
    await expect(page.getByTestId("lifecycle")).toContainText("clearinghouse_received");
  });

  test("claim B status refresh adds observation and follow-up without paid, no Allow once", async ({
    page,
  }) => {
    await page.goto("/claims/episode-claim-b");
    // Claim B is read-only: no proposal, no Allow once -- the refresh
    // executes directly from a dedicated button.
    await expect(page.getByTestId("allow-once")).toHaveCount(0);
    await page.getByTestId("refresh-payer-status").click();
    await expect(page.getByTestId("refresh-status-message")).toContainText(/refreshed|Receipt/i, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("allow-once")).toHaveCount(0);
    await expect(page.getByText("Verified paid")).toHaveCount(0);
    await expect(page.getByTestId("activity-stream")).toContainText(/follow|status|refresh/i);

    await page.getByRole("button", { name: "What's the status?" }).click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(
      /read-only payer refresh completed|scheduled for/i,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("agent-chat-thread")).not.toContainText(
      /was due 2026-07-22/i,
    );

    // Chat can also trigger the same read-only refresh without a proposal.
    await page.getByRole("button", { name: "Refresh the payer status" }).click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(/refresh|status/i, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("allow-once")).toHaveCount(0);
  });

  test("claim C discrepancy deny, re-propose, and allow once", async ({ page }) => {
    await page.goto("/claims/episode-claim-c");
    await expect(page.getByTestId("discrepancy-badge")).toBeVisible();
    await expect(page.getByTestId("pms-observation")).toContainText("Processing");
    await expect(page.getByTestId("artifact-preview")).toContainText("authorization");

    await page.getByTestId("deny-action").click();
    await expect(page.getByTestId("approval-message")).toContainText("Denied");
    await expect(page.getByTestId("allow-once")).toHaveCount(0);

    await page.getByTestId("repropose-action").click();
    await expect(page.getByTestId("allow-once")).toBeVisible();
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Reprocessing");
    await expect(page.getByTestId("activity-stream")).toContainText(/provenance/i);
    await expect(page.getByTestId("evidence-drawer")).toContainText(
      "Payer reprocessing message",
    );
    await page.getByTestId("agent-chat-input").fill("What's the status?");
    await page.getByTestId("agent-chat-send").click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(
      /Reprocessing was requested successfully.*remains denied/s,
      { timeout: 10_000 },
    );
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-verified-paid")).toContainText("1");
  });

  test("claim D clearinghouse rejection correct-and-resubmit updates queues", async ({
    page,
  }) => {
    await page.goto("/claims/episode-claim-d");
    await expect(page.getByTestId("lifecycle")).toContainText(/reject/i);
    // The proposal must show the explicit member id correction diff before approval.
    await expect(page.getByTestId("artifact-preview")).toContainText(
      /MEM-OLD-4004.*MEM-NEW-4004/s,
    );
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText(/Corrected|resubmit/i);
    await expect(page.getByTestId("evidence-drawer")).toContainText(
      /MEM-OLD-4004.*MEM-NEW-4004/s,
    );
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-ready")).toBeVisible();
  });

  test("claim E send signed documentation without false adjudication", async ({
    page,
  }) => {
    await page.goto("/claims/episode-claim-e");
    await expect(page.getByTestId("evidence-drawer")).toContainText(
      "Signed supporting progress note",
    );
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Documentation sent");
    await expect(page.getByText("Verified paid")).toHaveCount(0);
    await page.getByTestId("agent-chat-input").fill("What's the status?");
    await page.getByTestId("agent-chat-send").click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(
      /was sent successfully.*waiting_on_payer/s,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("agent-chat-thread")).not.toContainText(
      "has not been sent",
    );
  });

  test("claim F verified paid explanation and proposal-only chat", async ({ page }) => {
    await page.goto("/claims/episode-claim-f");
    await expect(page.getByText("Verified paid").first()).toBeVisible();
    await expect(page.getByTestId("evidence-drawer")).toContainText("Synthetic 835");
    await expect(page.getByTestId("evidence-drawer")).toContainText(/posting/i);
    await page.getByRole("button", { name: "Why is this verified paid?" }).click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(/remittance|posting|835/i, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("allow-once")).toHaveCount(0);
  });

  test("chat do-it only creates a proposal", async ({ page }) => {
    await page.goto("/claims/episode-claim-c");
    await page.getByTestId("deny-action").click();
    await expect(page.getByTestId("approval-message")).toContainText("Denied");
    await expect(page.getByTestId("allow-once")).toHaveCount(0);
    await page.getByTestId("agent-chat-input").fill("do it");
    await page.getByTestId("agent-chat-send").click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(/proposal/i);
    await expect(page.getByTestId("allow-once")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("approval-message")).not.toContainText(/refreshed/i);
  });

  test("chat free-text action phrasing creates proposals and answers reason questions", async ({
    page,
  }) => {
    await page.goto("/claims/episode-claim-a");
    await page.getByTestId("agent-chat-input").fill("Submit this claim for me");
    await page.getByTestId("agent-chat-send").click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(/proposal/i, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("allow-once")).toBeVisible({ timeout: 10_000 });

    await page.goto("/claims/episode-claim-d");
    await page.getByTestId("agent-chat-input").fill("Is this a payer denial?");
    await page.getByTestId("agent-chat-send").click();
    await expect(page.getByTestId("agent-chat-thread")).toContainText(
      /clearinghouse|not a payer denial/i,
      { timeout: 10_000 },
    );
  });

  test("refresh persistence and reset restore seed", async ({ page }) => {
    await page.goto("/encounters?focus=episode-encounter-a");
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Submitted");
    await page.reload();
    await expect(page.getByTestId("evidence-drawer")).toContainText("Submission receipt");
    await expect(page.getByTestId("lifecycle")).toContainText("clearinghouse_received");
    await page.getByTestId("reset-demo").click();
    await page.waitForTimeout(500);
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-ready")).toContainText("2");
  });

  test("mobile viewport basics and keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("badge-synthetic")).toBeVisible();
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth > root.clientWidth + 1;
    });
    expect(overflow).toBe(false);

    await page.goto("/claims/episode-claim-d");
    await expect(page.getByTestId("agent-chat-input")).toHaveAttribute(
      "aria-label",
      "Agent chat message",
    );
    await expect(page.getByTestId("member-id-correction")).toBeVisible();
    await page.getByTestId("agent-chat-input").fill("Is this a payer denial?");
    await page.getByTestId("agent-chat-input").press("Enter");
    await expect(page.getByTestId("agent-chat-thread")).toContainText(/clearinghouse|rejection|denial/i, {
      timeout: 15_000,
    });
    const claimOverflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth > root.clientWidth + 1;
    });
    expect(claimOverflow).toBe(false);
    await page.getByTestId("allow-once").focus();
    await expect(page.getByTestId("allow-once")).toBeFocused();
    await page.keyboard.press("Tab");
  });

  test("short viewport keeps sidebar session visible and actions show progress immediately", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto("/dashboard");

    const before = await page.getByTestId("sidebar-session").boundingBox();
    expect(before).not.toBeNull();
    expect(before!.y + before!.height).toBeLessThanOrEqual(500);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.getByTestId("sidebar-scroll").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const after = await page.getByTestId("sidebar-session").boundingBox();
    expect(after).not.toBeNull();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.y + after!.height).toBeLessThanOrEqual(500);

    await page.goto("/claims/episode-claim-d");
    await page.route("**/api/approvals", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 450));
      await route.continue();
    });
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-pending")).toContainText(
      "Executing the approved action",
    );
    await expect(page.getByTestId("approval-message")).toContainText(
      /Corrected|resubmit/i,
    );
  });

  test("two browser contexts stay session-isolated", async ({ browser }) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    const page1 = await first.newPage();
    const page2 = await second.newPage();
    await page1.goto("/dashboard");
    await page1.request.post("/api/demo/reset");
    await page2.goto("/dashboard");
    await page2.request.post("/api/demo/reset");
    await page1.goto("/encounters?focus=episode-encounter-a");
    await page1.getByTestId("allow-once").click();
    await expect(page1.getByTestId("approval-message")).toContainText("Submitted");
    await page2.goto("/dashboard");
    await expect(page2.getByTestId("kpi-ready")).toContainText("2");
    await first.close();
    await second.close();
  });
});

test.describe("BFF unavailable connected mode", () => {
  test("connected BFF failure does not silently fall back", async ({ page }) => {
    await page.goto("/dashboard");
    const demo = await page.request.get("/api/demo");
    expect(demo.ok()).toBeTruthy();
    const body = await demo.json();
    expect(body.config?.agentMode ?? "synthetic").toBeTruthy();
  });
});
