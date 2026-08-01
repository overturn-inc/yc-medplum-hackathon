import { NextResponse } from "next/server";
import { getDemoRuntime } from "@/server/demo";
import { createAgentChatService } from "@/server/agent-chat";
import { storeFromRequest } from "@/server/request-store";
import { StoreDegradedError } from "@/server/store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { repo, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    clientRequestId?: string;
    revision?: number;
  };

  if (!body.message || !body.message.trim()) {
    return withCookie(
      NextResponse.json({ error: "message is required" }, { status: 400 }),
    );
  }

  try {
    const runtime = await getDemoRuntime(repo);
    const chat = createAgentChatService(
      repo,
      runtime.actions,
      runtime.agent,
      runtime.retrieval,
    );
    const result = await chat.handleChat({
      episodeId: id,
      message: body.message,
      clientRequestId: body.clientRequestId,
      revision: body.revision,
    });
    return withCookie(NextResponse.json(result));
  } catch (error) {
    if (error instanceof StoreDegradedError) {
      return withCookie(
        NextResponse.json(
          { error: error.message, recovery: error.recovery },
          { status: 503 },
        ),
      );
    }
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    const message = error instanceof Error ? error.message : "Chat failed";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
