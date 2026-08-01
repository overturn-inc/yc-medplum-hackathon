import { NextResponse } from "next/server";
import { toolJobActionSchema } from "@/domain/tool-jobs";
import { storeFromRequest } from "@/server/request-store";
import { ToolJobService } from "@/server/tool-jobs";
import {
  ToolJobRateLimitError,
  ToolJobRevisionError,
} from "@/server/tool-job-ledger";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { repo, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  try {
    const body = (await request.json()) as {
      episodeId?: string;
      action?: string;
      idempotencyKey?: string;
    };
    if (!body.episodeId || typeof body.episodeId !== "string") {
      return withCookie(
        NextResponse.json({ error: "episodeId is required" }, { status: 400 }),
      );
    }
    const parsedAction = toolJobActionSchema.safeParse(body.action);
    if (!parsedAction.success) {
      return withCookie(
        NextResponse.json({ error: "Unknown or missing tool job action" }, { status: 400 }),
      );
    }

    const service = new ToolJobService(repo);
    const started = Date.now();
    const result = await service.create({
      episodeId: body.episodeId,
      action: parsedAction.data,
      idempotencyKey:
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    });
    const response = NextResponse.json({
      ...result,
      progressAppearedMs: Date.now() - started,
    });
    return withCookie(response);
  } catch (error) {
    const status =
      error instanceof ToolJobRateLimitError ||
      error instanceof ToolJobRevisionError
        ? error.status
        : typeof error === "object" &&
            error &&
            "status" in error &&
            typeof (error as { status: unknown }).status === "number"
          ? ((error as { status: number }).status)
          : 500;
    const message = error instanceof Error ? error.message : "Tool job create failed";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
