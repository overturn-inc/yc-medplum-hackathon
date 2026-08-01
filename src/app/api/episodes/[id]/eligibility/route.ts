import { NextResponse } from "next/server";
import {
  createStediClient,
  createStediMockEligibilityRequest,
  StediApiError,
} from "@/adapters/clearinghouse/stedi";
import { loadServerConfig } from "@/server/config";
import { getDemoRuntime } from "@/server/demo";
import { storeFromRequest } from "@/server/request-store";
import { StoreDegradedError } from "@/server/store";
import { assertActionRateLimit, ToolJobRateLimitError } from "@/server/tool-job-ledger";

export const dynamic = "force-dynamic";

/**
 * Executes the documented Stedi 270/271 mock request for the synthetic Jane
 * Doe encounter. The route never accepts arbitrary patient fields and is not
 * enabled without a server-only test key.
 *
 * Durable evidence: on first success, the normalized result (checkId, test
 * mode, hasRaw271 flag, activeCoverage, benefit summary -- never the raw
 * X12) is persisted on the episode via `ActionService.recordEligibilityCheck`.
 * Subsequent calls are idempotent and never re-call Stedi.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { repo, sessionId, setCookie } = await storeFromRequest(request);
  const withCookie = (response: NextResponse) => {
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  };

  try {
    const episode = await repo.getEpisode(id);
    if (!episode) {
      return withCookie(NextResponse.json({ error: "Episode not found" }, { status: 404 }));
    }
    if (episode.fixtureKey !== "encounter-a") {
      return withCookie(
        NextResponse.json(
          { error: "Live Stedi eligibility is limited to the approved synthetic encounter." },
          { status: 400 },
        ),
      );
    }

    const runtime = await getDemoRuntime(repo);

    // Idempotent: never re-call Stedi once a durable receipt is on file.
    if (episode.eligibilityReceiptId && episode.eligibilitySummary) {
      const summary = episode.eligibilitySummary;
      return withCookie(
        NextResponse.json({
          ...summary,
          source: "Stedi 270/271",
          patient: "Jane Doe",
          payer: "UnitedHealthcare",
          synthetic: true,
          liveApi: false,
          idempotent: true,
        }),
      );
    }

    try {
      assertActionRateLimit("eligibility", sessionId);
    } catch (error) {
      if (error instanceof ToolJobRateLimitError) {
        return withCookie(NextResponse.json({ error: error.message }, { status: 429 }));
      }
      throw error;
    }

    const config = loadServerConfig();
    if (config.stediMode !== "test" || !config.stediApiKey) {
      return withCookie(
        NextResponse.json(
          { error: "Stedi test eligibility is not configured." },
          { status: 503 },
        ),
      );
    }

    const client = createStediClient({
      apiKey: config.stediApiKey,
      mode: "test",
      baseUrl: config.stediBaseUrl,
    });
    const result = await client.checkEligibility(createStediMockEligibilityRequest());

    await runtime.actions.recordEligibilityCheck(id, {
      checkId: result.checkId,
      applicationMode: result.applicationMode,
      activeCoverage: result.activeCoverage,
      activeBenefitCount: result.activeBenefitCount,
      planNames: result.planNames,
      hasRaw271: result.hasRaw271,
    });

    return withCookie(
      NextResponse.json({
        checkId: result.checkId,
        applicationMode: result.applicationMode,
        activeCoverage: result.activeCoverage,
        activeBenefitCount: result.activeBenefitCount,
        planNames: result.planNames,
        hasRaw271: result.hasRaw271,
        source: "Stedi 270/271",
        patient: "Jane Doe",
        payer: "UnitedHealthcare",
        synthetic: true,
        liveApi: true,
        idempotent: false,
      }),
    );
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
      error instanceof StediApiError
        ? error.status
        : typeof error === "object" && error && "status" in error
          ? Number((error as { status: number }).status)
          : 500;
    const message =
      error instanceof StediApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Stedi eligibility check failed.";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
