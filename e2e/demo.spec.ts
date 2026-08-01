import { expect, test } from "@playwright/test";

test.describe("Harborview PMS demo (A01-A18)", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("/api/demo/reset");
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
    await expect(page.getByTestId("claims-table").getByRole("row")).toHaveCount(4);

    await page.goto("/encounters");
    await expect(page.getByTestId("encounters-page")).toBeVisible();
    await page.goto("/claims");
    await expect(page.getByTestId("claims-page")).toBeVisible();
    await page.goto("/claims/episode-claim-c");
    await expect(page.getByTestId("claim-detail-page")).toBeVisible();
  });

  test("encounter preflight deny is safe and allow once submits", async ({ page }) => {
    await page.goto("/encounters?focus=episode-encounter-a");
    await expect(page.getByTestId("preflight-checks")).toBeVisible();
    await expect(
      page.getByTestId("preflight-checks").getByText("Final note"),
    ).toBeVisible();
    await expect(
      page.getByTestId("preflight-checks").getByText("Active coverage"),
    ).toBeVisible();

    await page.getByTestId("deny-action").click();
    await expect(page.getByTestId("approval-message")).toContainText("Denied");
    await expect(page.getByTestId("approval-message")).toContainText(
      "No external write",
    );
    // Terminal deny clears the proposal until an explicit new proposal is created.
    await expect(page.getByTestId("allow-once")).toHaveCount(0);
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-ready")).toContainText("2");

    await page.getByTestId("reset-demo").click();
    await page.waitForTimeout(400);
    await page.goto("/encounters?focus=episode-encounter-a");
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Submitted");
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-ready")).toContainText("1");
  });

  test("claim C discrepancy reprocessing flow", async ({ page }) => {
    await page.goto("/claims/episode-claim-c");
    await expect(page.getByTestId("discrepancy-badge")).toBeVisible();
    await expect(page.getByTestId("pms-observation")).toContainText("Processing");
    await expect(page.getByTestId("artifact-preview")).toContainText("authorization");
    await expect(page.getByTestId("proposal-evidence")).toContainText(
      "DocumentReference/doc-auth-claim-c",
    );

    await page.getByTestId("deny-action").click();
    await expect(page.getByTestId("approval-message")).toContainText("Denied");
    await expect(page.getByTestId("approval-message")).toContainText("No external write");

    await page.getByTestId("reset-demo").click();
    await page.waitForTimeout(400);
    await page.goto("/claims/episode-claim-c");
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Reprocessing");
    await expect(page.getByTestId("activity-stream")).toContainText("provenance");
    await expect(page.getByTestId("evidence-drawer")).toContainText(
      "Payer reprocessing message",
    );
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-verified-paid")).toContainText("1");
  });

  test("refresh persistence and reset restore seed", async ({ page }) => {
    await page.goto("/encounters?focus=episode-encounter-a");
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("approval-message")).toContainText("Submitted");
    await page.reload();
    await expect(page.getByTestId("workbench-episode-encounter-a")).toContainText(
      "monitoring",
    );
    await expect(page.getByTestId("evidence-drawer")).toContainText("Submission receipt");
    await page.getByTestId("reset-demo").click();
    await page.waitForTimeout(400);
    await page.goto("/dashboard");
    await expect(page.getByTestId("kpi-ready")).toContainText("2");
  });

  test("claim F shows verified paid with remittance and posting", async ({ page }) => {
    await page.goto("/claims/episode-claim-f");
    await expect(page.getByText("Verified paid")).toBeVisible();
    await expect(page.getByTestId("evidence-drawer")).toContainText("Synthetic 835");
    await expect(page.getByTestId("financials")).toContainText("$152.00");
  });
});
