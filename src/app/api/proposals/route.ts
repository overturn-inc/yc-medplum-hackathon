import { NextResponse } from "next/server";
import { getDemoRuntime } from "@/server/demo";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    episodeId?: string;
    actionType?: "submit_claim" | "request_reprocessing";
  };
  if (!body.episodeId || !body.actionType) {
    return NextResponse.json({ error: "episodeId and actionType are required" }, { status: 400 });
  }
  try {
    const runtime = getDemoRuntime();
    const result = runtime.actions.createProposal(body.episodeId, body.actionType);
    return NextResponse.json(result);
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proposal failed" },
      { status },
    );
  }
}
