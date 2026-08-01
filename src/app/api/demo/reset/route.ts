import { NextResponse } from "next/server";
import { getStore } from "@/server/store";
import { computeDashboardKpi, buildQueues, projectEpisodes } from "@/domain/projector";

export const dynamic = "force-dynamic";

export async function POST() {
  const store = getStore();
  const snapshot = store.reset();
  return NextResponse.json({
    ok: true,
    sessionRevision: snapshot.sessionRevision,
    kpi: computeDashboardKpi(snapshot.episodes),
    queues: buildQueues(snapshot.episodes),
    episodes: projectEpisodes(snapshot.episodes),
    message: "Demo session reset to synthetic seed. Connected resources were not deleted.",
  });
}
