import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const BFF_PORT = Number(process.env.PLAYWRIGHT_BFF_PORT ?? 3101);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BFF_BASE_URL = `http://127.0.0.1:${BFF_PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /bff\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "bff-chromium",
      testMatch: /bff\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: BFF_BASE_URL,
      },
    },
  ],
  webServer: [
    {
      command: `npx next start --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        DEMO_DATA_DIR: `.playwright-data-${PORT}`,
        DEMO_INSECURE_COOKIES: "1",
        HEALTHCARE_MODE: "local",
        AGENT_MODE: "synthetic",
        MOSS_MODE: "off",
      },
    },
    {
      command: `npx next start --port ${BFF_PORT}`,
      url: BFF_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        DEMO_DATA_DIR: `.playwright-data-bff-${BFF_PORT}`,
        DEMO_INSECURE_COOKIES: "1",
        HEALTHCARE_MODE: "local",
        AGENT_MODE: "bff",
        BFF_BASE_URL: "https://bff.invalid.example",
        BFF_API_KEY: "test-key-not-a-secret",
        MOSS_MODE: "off",
      },
    },
  ],
});
