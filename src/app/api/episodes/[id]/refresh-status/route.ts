import { NextResponse } from "next/server";
import { getDemoRuntime } from "@/server/demo";
import { storeFromRequest } from "@/server/request-store";
import { StoreDegradedError } from "@/server/store";

export const dynamic = "force-dynamic";

/**
 * Claim B's read-only payer status refresh. Deliberately NOT a
 * proposal/Allow-once endpoint: this only re-checks the payer portal and
 * appends a status observation, so it executes directly without going
 * through `/api/proposals` or `/api/approvals`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { repo, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  try {
    const runtime = await getDemoRuntime(repo);
    const result = await runtime.actions.refreshPayerStatus(id);
    return withCookie(NextResponse.json(result));
  } catch (error) {
    if (error instanceof StoreDegradedError) {
      return withCookie(
        NextResponse.json(
          { error: error.message, recovery: error.recovery },
          { status: 503 },
        ),
      );
    }
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    const message = error instanceof Error ? error.message : "Refresh failed";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
