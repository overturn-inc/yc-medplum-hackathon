import { NextResponse } from "next/server";
import { defaultActionTypeForFixture, type ProposableActionType } from "@/domain/proposals";
import { getDemoRuntime } from "@/server/demo";
import { storeFromRequest } from "@/server/request-store";

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
  };
  if (!body.episodeId) {
    return withCookie(
      NextResponse.json({ error: "episodeId is required" }, { status: 400 }),
    );
  }
  try {
    // The server -- never the client -- decides which action a proposal is
    // for. `actionType` may only be supplied by the client to request a
    // fixture's own scripted default; anything else is rejected outright,
    // and `ActionService.createProposal` re-validates via the server-owned
    // action policy before ever building a proposal.
    const episode = await repo.getEpisode(body.episodeId);
    if (!episode) {
      return withCookie(
        NextResponse.json({ error: "Episode not found" }, { status: 404 }),
      );
    }
    const serverAction = defaultActionTypeForFixture(episode.fixtureKey);
    if (body.actionType && body.actionType !== serverAction) {
      return withCookie(
        NextResponse.json(
          {
            error: `actionType ${body.actionType} does not match the server-derived action for ${episode.fixtureKey}`,
          },
          { status: 400 },
        ),
      );
    }
    const runtime = await getDemoRuntime(repo);
    const result = await runtime.actions.createProposal(
      body.episodeId,
      serverAction ?? undefined,
    );
    return withCookie(NextResponse.json(result));
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    return withCookie(
      NextResponse.json(
        { error: error instanceof Error ? error.message : "Proposal failed" },
        { status },
      ),
    );
  }
}
