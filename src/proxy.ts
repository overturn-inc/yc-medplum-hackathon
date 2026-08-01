import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ensureSessionId, SESSION_COOKIE_NAME } from "@/server/session";

/**
 * Guarantees every request (page render or API route) carries the
 * `hv_demo_session` cookie before it reaches Server Components or route
 * handlers. Server Components can read cookies but cannot set them, so the
 * cookie must be minted here -- ahead of rendering -- and propagated onto
 * the *incoming* request headers so the same request's RSC tree observes it
 * via `next/headers`'s `cookies()`.
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy` (same
 * network-boundary hook, Node.js runtime by default).
 */
export function proxy(request: NextRequest) {
  const { sessionId, setCookie } = ensureSessionId(request);
  if (!setCookie) {
    return NextResponse.next();
  }

  const requestHeaders = new Headers(request.headers);
  const existing = request.headers.get("cookie");
  const sessionPair = `${SESSION_COOKIE_NAME}=${sessionId}`;
  requestHeaders.set(
    "cookie",
    existing && existing.length > 0 ? `${existing}; ${sessionPair}` : sessionPair,
  );

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.append("Set-Cookie", setCookie);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
