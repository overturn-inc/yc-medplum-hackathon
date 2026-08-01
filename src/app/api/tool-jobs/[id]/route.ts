import { NextResponse } from "next/server";
import { storeFromRequest } from "@/server/request-store";
import { ToolJobService } from "@/server/tool-jobs";
import { ToolJobRevisionError } from "@/server/tool-job-ledger";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { repo, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  try {
    const service = new ToolJobService(repo);
    const job = await service.poll(id);
    return withCookie(NextResponse.json({ job }));
  } catch (error) {
    const status =
      error instanceof ToolJobRevisionError
        ? error.status
        : typeof error === "object" &&
            error &&
            "status" in error &&
            typeof (error as { status: unknown }).status === "number"
          ? (error as { status: number }).status
          : 500;
    const message = error instanceof Error ? error.message : "Tool job poll failed";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
