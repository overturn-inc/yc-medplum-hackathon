/**
 * Resolves the session-scoped repository for an incoming request (API route
 * handlers) or the current render (Server Components / pages).
 *
 * When the vinext Worker has injected `env.DB` onto `globalThis.__HARBORVIEW_ENV__`,
 * the Cloudflare D1 repository is selected. Otherwise local development and
 * tests use the in-memory (optionally disk-mirrored) repository.
 */
import { cookies } from "next/headers";
import {
  createSessionRepository,
  type SessionRepository,
} from "@/server/repository";
import { ensureSessionId, SESSION_COOKIE_NAME } from "@/server/session";
import type { StoreOptions } from "@/server/store";

export interface RequestStoreResult {
  repo: SessionRepository;
  sessionId: string;
  /** Present only when a new session id was minted for this request; attach as a `Set-Cookie` response header. */
  setCookie?: string;
}

/** For Route Handlers (`src/app/api/**`), which receive a standard `Request`. */
export async function storeFromRequest(
  request: Request,
  options?: StoreOptions,
): Promise<RequestStoreResult> {
  const { sessionId, setCookie } = ensureSessionId(request);
  const repo = createSessionRepository(sessionId, options);
  return { repo, sessionId, setCookie };
}

/**
 * For Server Components / pages, which cannot see the raw `Request` and
 * cannot set cookies themselves. Relies on `src/middleware.ts` having
 * already minted and propagated `hv_demo_session` onto this request; falls
 * back to a fresh ephemeral (non-cookie-persisted) session if it's somehow
 * missing, rather than sharing one global store across visitors.
 */
export async function storeFromCookies(
  options?: StoreOptions,
): Promise<SessionRepository> {
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE_NAME)?.value ?? crypto.randomUUID();
  return createSessionRepository(sessionId, options);
}
