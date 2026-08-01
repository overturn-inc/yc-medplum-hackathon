import { NextResponse } from "next/server";
import { getEpisodeView } from "@/server/demo";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const view = await getEpisodeView(id);
  if (!view) {
    return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  }
  return NextResponse.json(view);
}
