import { NextResponse } from "next/server";
import { sanitizeBffError } from "@/adapters/agent/bff";
import type { ProposableActionType } from "@/domain/proposals";
import { getDemoRuntime } from "@/server/demo";
import { storeFromRequest } from "@/server/request-store";
import { StoreDegradedError } from "@/server/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { repo, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  const body = (await request.json()) as {
    episodeId?: string;
    actionType?: ProposableActionType;
    decision?: "allow_once" | "deny";
    proposalId?: string;
    payloadDigest?: string;
    episodeRevision?: number;
    fingerprint?: string;
  };

  if (!body.episodeId || !body.actionType || !body.decision) {
    return withCookie(
      NextResponse.json(
        { error: "episodeId, actionType, and decision are required" },
        { status: 400 },
      ),
    );
  }

  const runtime = await getDemoRuntime(repo);

  if (runtime.config.agentMode === "bff") {
    const probe = runtime.agent.probe
      ? await runtime.agent.probe()
      : { available: false, error: "BFF probe unavailable" };
    if (!probe.available && body.decision === "allow_once") {
      const sanitized = sanitizeBffError(
        new Error(probe.error ?? "BFF unavailable"),
      );
      return withCookie(
        NextResponse.json(
          {
            error: `${sanitized.message}. Approved action was not executed. No synthetic fallback.`,
            agentMode: "bff",
          },
          { status: 503 },
        ),
      );
    }
  }

  try {
    const result = await runtime.actions.decide({
      episodeId: body.episodeId,
      actionType: body.actionType,
      decision: body.decision,
      scope:
        body.proposalId &&
        body.payloadDigest &&
        body.fingerprint &&
        typeof body.episodeRevision === "number"
          ? {
              proposalId: body.proposalId,
              episodeId: body.episodeId,
              actionType: body.actionType,
              payloadDigest: body.payloadDigest,
              episodeRevision: body.episodeRevision,
              fingerprint: body.fingerprint,
            }
          : undefined,
    });
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
    const message = error instanceof Error ? error.message : "Decision failed";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
