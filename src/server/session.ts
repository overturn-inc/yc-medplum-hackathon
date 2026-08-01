/**
 * Session cookie helpers for the demo's per-browser durable session.
 *
 * The cookie value is an opaque random session id (crypto.randomUUID()).
 * It never carries user identity, credentials, or PHI -- it is only a
 * lookup key into the session-scoped repository (see repository.ts).
 */

export const SESSION_COOKIE_NAME = "hv_demo_session";

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnsureSessionIdResult {
  sessionId: string;
  /** Present only when a new session id was minted; caller must attach as a `Set-Cookie` response header. */
  setCookie?: string;
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

/** Reads the session id from the request's `Cookie` header, or null if absent/malformed. */
export function readSessionId(request: Request): string | null {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const value = cookies.get(SESSION_COOKIE_NAME);
  if (!value || !UUID_RE.test(value)) return null;
  return value;
}

/**
 * Builds the `Set-Cookie` header value for a newly issued session id.
 *
 * Local Next.js (`next dev`) and Playwright (`next start` over HTTP) must not
 * mark the cookie Secure, or browsers silently drop it. Production HTTPS
 * deploys keep Secure. Override with DEMO_INSECURE_COOKIES=1 for HTTP smoke.
 */
export function issueSessionCookie(sessionId: string): string {
  const insecure =
    process.env.DEMO_INSECURE_COOKIES === "1" ||
    process.env.NODE_ENV !== "production";
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (!insecure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

/**
 * Returns the request's session id, minting and returning a fresh one (plus
 * the `Set-Cookie` header to send back) when the request has none yet.
 */
export function ensureSessionId(request: Request): EnsureSessionIdResult {
  const existing = readSessionId(request);
  if (existing) {
    return { sessionId: existing };
  }
  const sessionId = crypto.randomUUID();
  return { sessionId, setCookie: issueSessionCookie(sessionId) };
}
