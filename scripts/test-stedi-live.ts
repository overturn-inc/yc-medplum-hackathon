import {
  createStediClient,
  createStediMockEligibilityRequest,
  StediApiError,
} from "../src/adapters/clearinghouse/stedi";

const apiKey = process.env.STEDI_API_KEY;
if (!apiKey) throw new Error("STEDI_API_KEY is required");

const client = createStediClient({
  apiKey,
  mode: "test",
  baseUrl: process.env.STEDI_BASE_URL,
});

const eligibility = await client.checkEligibility(createStediMockEligibilityRequest());
if (
  eligibility.applicationMode !== "test" ||
  !eligibility.activeCoverage ||
  eligibility.errors.length > 0 ||
  !eligibility.hasRaw271
) {
  throw new Error("Stedi eligibility response did not satisfy the live acceptance criteria");
}
console.log(
  JSON.stringify({
    eligibility: {
      ok: true,
      checkId: eligibility.checkId,
      applicationMode: eligibility.applicationMode,
      activeBenefitCount: eligibility.activeBenefitCount,
      hasRaw271: eligibility.hasRaw271,
    },
  }),
);

try {
  await client.submitProfessionalClaim({ usageIndicator: "T" });
  console.log(JSON.stringify({ professionalClaims: { available: true } }));
} catch (error) {
  if (!(error instanceof StediApiError) || error.status !== 403) throw error;
  console.log(
    JSON.stringify({
      professionalClaims: {
        available: false,
        status: error.status,
        code: error.code,
        reason: "Sandbox account only authorizes test eligibility API calls",
      },
    }),
  );
}
