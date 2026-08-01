import { NextResponse } from "next/server";
import { getDemoViewModel } from "@/server/demo";

export const dynamic = "force-dynamic";

export async function GET() {
  const model = await getDemoViewModel();
  if (!model.ok) {
    return NextResponse.json(
      {
        error: model.error,
        healthcareMode: model.config.healthcareMode,
        agentMode: model.config.agentMode,
      },
      { status: 503 },
    );
  }
  return NextResponse.json({
    demoClock: model.demoClock,
    sessionRevision: model.sessionRevision,
    config: model.config,
    kpi: model.kpi,
    queues: model.queues,
    episodes: model.episodes,
  });
}
