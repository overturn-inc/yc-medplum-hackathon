import { NextResponse } from "next/server";
import { getEpisodeView } from "@/server/demo";
import { storeFromRequest } from "@/server/request-store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { repo, setCookie } = await storeFromRequest(request);
  const view = await getEpisodeView(id, repo);
  const response = view
    ? NextResponse.json(view)
    : NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}
