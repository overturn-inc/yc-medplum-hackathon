import { chromium } from "playwright";
import { config } from "./config.mjs";

const portalOrigin = new URL(config.portalBaseUrl).origin;

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: config.browserHeadless,
      // Non-root, --cap-drop ALL containers cannot use the setuid sandbox
      // helper; this is the standard, documented Playwright container
      // workaround and is scoped by the origin/request allowlist below.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserPromise;
}

/**
 * Runs `callback(page)` inside a fresh, isolated browser context that can
 * only reach the local fictional portal origin. The context (and its page)
 * is always closed afterwards, whether the callback resolves, throws, or is
 * aborted by the job timeout.
 */
export async function withPortalPage(callback) {
  const browser = await getBrowser();
  const context = await browser.newContext({ baseURL: config.portalBaseUrl });
  try {
    await context.route("**/*", (route) => {
      const requestUrl = route.request().url();
      if (new URL(requestUrl).origin !== portalOrigin) {
        route.abort();
        return;
      }
      route.continue();
    });
    const page = await context.newPage();
    return await callback(page, context);
  } finally {
    await context.close().catch(() => {});
  }
}

export function assertPortalUrl(pathAndQuery) {
  const url = new URL(pathAndQuery, `${config.portalBaseUrl}/`);
  if (url.origin !== portalOrigin) {
    throw new Error("Refusing to navigate outside the local fictional portal origin");
  }
  return url.toString();
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  await browser?.close().catch(() => {});
}
