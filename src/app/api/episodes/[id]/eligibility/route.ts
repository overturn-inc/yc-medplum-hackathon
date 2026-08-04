import { NextResponse } from "next/server";
import {
  createStediClient,
  createStediMockEligibilityRequest,
  StediApiError,
} from "@/adapters/clearinghouse/stedi";
import { loadServerConfig } from "@/server/config";
import { storeFromRequest } from "@/server/request-store";

export const dynamic = "force-dynamic";

/**
 * Executes the documented Stedi 270/271 mock request for the synthetic Jane
 * Doe encounter. The route never accepts arbitrary patient fields and is not
 * enabled without a server-only test key.
 */
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
    return withCookie(
      NextResponse.json({
        ...result,
        source: "Stedi 270/271",
        patient: "Jane Doe",
        payer: "UnitedHealthcare",
        synthetic: true,
        liveApi: true,
      }),
    );
  } catch (error) {
    const status = error instanceof StediApiError ? error.status : 500;
    const message =
      error instanceof StediApiError
        ? error.message
        : "Stedi eligibility check failed.";
    return withCookie(NextResponse.json({ error: message }, { status }));
  }
}
