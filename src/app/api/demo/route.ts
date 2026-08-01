import { NextResponse } from "next/server";
import { getDemoViewModel } from "@/server/demo";
import { storeFromRequest } from "@/server/request-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { repo, setCookie } = await storeFromRequest(request);
  const model = await getDemoViewModel(repo);
  if (!model.ok) {
    const response = NextResponse.json(
      {
        error: model.error,
        healthcareMode: model.config.healthcareMode,
        agentMode: model.config.agentMode,
      },
      { status: 503 },
    );
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  }
  const response = NextResponse.json({
    demoClock: model.demoClock,
    sessionRevision: model.sessionRevision,
    config: model.config,
    kpi: model.kpi,
    queues: model.queues,
    episodes: model.episodes,
  });
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}
