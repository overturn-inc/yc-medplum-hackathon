import { NextResponse } from "next/server";
import { storeFromRequest } from "@/server/request-store";
import { computeDashboardKpi, buildQueues, projectEpisodes } from "@/domain/projector";
import { ToolJobService } from "@/server/tool-jobs";
import { ToolJobCancelError } from "@/server/tool-job-ledger";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { repo, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  // Active browser/voice tool jobs must be confirmed cancelled BEFORE the
  // session ledger resets, so no in-flight connector receipt can be applied
  // to a revision that no longer exists. Rate-limit windows intentionally
  // survive reset (see SessionToolJobLedger.cancelAllActive/clearJobsForReset).
  try {
    await new ToolJobService(repo).cancelActiveForReset();
  } catch (error) {
    if (error instanceof ToolJobCancelError) {
      return withCookie(
        NextResponse.json(
          {
            ok: false,
            error: error.message,
            recovery: "Retry reset once the active tool job finishes or is confirmed cancelled.",
          },
          { status: 409 },
        ),
      );
    }
    throw error;
  }

  const snapshot = await repo.reset();
  return withCookie(
    NextResponse.json({
      ok: true,
      sessionRevision: snapshot.sessionRevision,
      kpi: computeDashboardKpi(snapshot.episodes),
      queues: buildQueues(snapshot.episodes),
      episodes: projectEpisodes(snapshot.episodes),
      message: "Demo session reset to synthetic seed. Connected resources were not deleted.",
    }),
  );
}
