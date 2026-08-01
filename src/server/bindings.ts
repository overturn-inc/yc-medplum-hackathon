/**
 * Worker-injected Cloudflare bindings.
 * The vinext Worker entry sets `globalThis.__HARBORVIEW_ENV__` before handing
 * the request to the App Router so local Next.js never imports `cloudflare:workers`.
 */
import type { D1DatabaseLike } from "@/server/d1-repository";

export interface HarborviewEnv {
  DB?: D1DatabaseLike;
}

declare global {
  var __HARBORVIEW_ENV__: HarborviewEnv | undefined;
}

export function setHarborviewEnv(env: HarborviewEnv): void {
  globalThis.__HARBORVIEW_ENV__ = env;
}

export function getHarborviewEnv(): HarborviewEnv {
  return globalThis.__HARBORVIEW_ENV__ ?? {};
}

export function getD1Binding(): D1DatabaseLike | null {
  return getHarborviewEnv().DB ?? null;
}
