import { z } from "zod";

const DEFAULT_BASE_URL = "https://healthcare.us.stedi.com";
const ELIGIBILITY_PATH =
  "/2024-04-01/change/medicalnetwork/eligibility/v3";
const PROFESSIONAL_CLAIMS_PATH =
  "/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission";

export interface StediEligibilityRequest {
  tradingPartnerServiceId: string;
  encounter: { serviceTypeCodes: string[] };
  provider: { organizationName: string; npi: string };
  subscriber: { firstName: string; lastName: string; memberId: string };
  dependents?: Array<{
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  }>;
}
const eligibilityResponseSchema = z
  .object({
    id: z.string().min(1),
    meta: z.object({ applicationMode: z.string().min(1) }).passthrough(),
    tradingPartnerServiceId: z.string().min(1),
    errors: z
      .array(
        z
          .object({
            code: z.string().optional(),
            description: z.string().optional(),
            followupAction: z.string().optional(),
          })
          .passthrough(),
      )
      .nullish(),
    benefitsInformation: z
      .array(
        z
          .object({
            code: z.string().optional(),
            name: z.string().optional(),
            planCoverage: z.string().optional(),
            serviceTypes: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .default([]),
    x12: z.string().optional(),
  })
  .passthrough();

export interface StediEligibilityResult {
  checkId: string;
  applicationMode: string;
  payerId: string;
  activeCoverage: boolean;
  activeBenefitCount: number;
  planNames: string[];
  errors: Array<{
    code?: string;
    description?: string;
    followupAction?: string;
  }>;
  hasRaw271: boolean;
}

export class StediApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "StediApiError";
  }
}

export function createStediMockEligibilityRequest(): StediEligibilityRequest {
  return {
    tradingPartnerServiceId: "87726",
    encounter: { serviceTypeCodes: ["30"] },
    provider: {
      organizationName: "Provider Name",
      npi: "1999999984",
    },
    subscriber: {
      firstName: "John",
      lastName: "Doe",
      memberId: "UHC202649",
    },
    dependents: [
      {
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "19521121",
      },
    ],
  };
}

function sanitizeRemoteError(body: unknown, status: number): StediApiError {
  const parsed = z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .passthrough()
    .safeParse(body);
  const code = parsed.success ? parsed.data.code ?? "stedi_error" : "stedi_error";
  const remoteMessage = parsed.success ? parsed.data.message : undefined;
  const message =
    status === 403
      ? "Stedi rejected this operation for the configured account mode."
      : remoteMessage
        ? `Stedi request failed: ${remoteMessage}`
        : `Stedi request failed with HTTP ${status}.`;
  return new StediApiError(message, status, code);
}

export function createStediClient(input: {
  apiKey: string;
  mode: "test";
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}) {
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;

  async function post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: input.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new StediApiError("Stedi is unavailable.", 503, "stedi_unavailable");
    }

    const responseBody = await response.json().catch(() => null);
    if (!response.ok) throw sanitizeRemoteError(responseBody, response.status);
    return responseBody;
  }

  return {
    mode: input.mode,

    async checkEligibility(
      request: StediEligibilityRequest,
    ): Promise<StediEligibilityResult> {
      const body = eligibilityResponseSchema.parse(
        await post(ELIGIBILITY_PATH, request),
      );
      const activeBenefits = body.benefitsInformation.filter(
        (benefit) => benefit.code === "1" || benefit.name === "Active Coverage",
      );
      return {
        checkId: body.id,
        applicationMode: body.meta.applicationMode,
        payerId: body.tradingPartnerServiceId,
        activeCoverage: activeBenefits.length > 0,
        activeBenefitCount: activeBenefits.length,
        planNames: [
          ...new Set(
            activeBenefits
              .map((benefit) => benefit.planCoverage)
              .filter((name): name is string => Boolean(name)),
          ),
        ],
        errors: body.errors ?? [],
        hasRaw271: Boolean(body.x12),
      };
    },

    /**
     * Prepared for the clearinghouse claim rail, but always forces X12 test
     * usage. Sandbox eligibility keys currently receive a 403 from Stedi for
     * this endpoint; callers must surface that boundary and never synthesize a
     * success receipt.
     */
    async submitProfessionalClaim(
      request: Record<string, unknown>,
    ): Promise<unknown> {
      return post(PROFESSIONAL_CLAIMS_PATH, {
        ...request,
        usageIndicator: "T",
      });
    },
  };
}
