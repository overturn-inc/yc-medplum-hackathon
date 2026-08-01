import { NextResponse } from "next/server";
import { getDemoRuntime } from "@/server/demo";
import { storeFromRequest } from "@/server/request-store";
import { StoreDegradedError } from "@/server/store";

export const dynamic = "force-dynamic";

type HeroAction = "advance_follow_through" | "prepare_appeal";

/**
 * Guided hero claim (encounter-a) transitions that are not shaped like a
 * generic proposal/approval or tool job:
 * - `advance_follow_through`: deterministic, connector-free transition from
 *   claim_submitted to accepted_overdue (no external write).
 * - `prepare_appeal`: creates the submit_appeal proposal once the
 *   denial-upheld connector receipt exists. Approval still requires a
 *   separate POST /api/approvals Allow once.
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

  let body: { action?: HeroAction };
  try {
    body = (await request.json()) as { action?: HeroAction };
  } catch {
    return withCookie(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  if (body.action !== "advance_follow_through" && body.action !== "prepare_appeal") {
    return withCookie(
      NextResponse.json(
        { error: "action must be advance_follow_through or prepare_appeal" },
        { status: 400 },
      ),
    );
  }

  try {
    const runtime = await getDemoRuntime(repo);
    if (body.action === "advance_follow_through") {
      const result = await runtime.actions.advanceHeroFollowThrough(id);
      return withCookie(NextResponse.json(result));
    }
    const result = await runtime.actions.createProposal(id, "submit_appeal");
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
    const message = error instanceof Error ? error.message : "Hero action failed";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
