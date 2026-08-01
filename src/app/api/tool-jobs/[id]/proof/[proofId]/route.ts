import { NextResponse } from "next/server";
import { storeFromRequest } from "@/server/request-store";
import { ToolJobService } from "@/server/tool-jobs";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; proofId: string }> },
) {
  const { id, proofId } = await context.params;
  const { repo, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  try {
    const service = new ToolJobService(repo);
    const proof = await service.getProof(id, proofId);
    const response = new NextResponse(Buffer.from(proof.bytes), {
      status: 200,
      headers: {
        "Content-Type": proof.contentType,
        "Cache-Control": "no-store",
      },
    });
    return withCookie(response);
  } catch (error) {
    const status =
      typeof error === "object" &&
      error &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    const message = error instanceof Error ? error.message : "Proof fetch failed";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
