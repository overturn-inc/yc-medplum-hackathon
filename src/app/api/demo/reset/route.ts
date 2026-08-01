import { NextResponse } from "next/server";
import { storeFromRequest } from "@/server/request-store";
import { computeDashboardKpi, buildQueues, projectEpisodes } from "@/domain/projector";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { repo, setCookie } = await storeFromRequest(request);
  const snapshot = await repo.reset();
  const response = NextResponse.json({
    ok: true,
    sessionRevision: snapshot.sessionRevision,
    kpi: computeDashboardKpi(snapshot.episodes),
    queues: buildQueues(snapshot.episodes),
    episodes: projectEpisodes(snapshot.episodes),
    message: "Demo session reset to synthetic seed. Connected resources were not deleted.",
  });
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}
