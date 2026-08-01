import { describe, expect, it, vi } from "vitest";
import {
  createStediClient,
  createStediMockEligibilityRequest,
  StediApiError,
} from "@/adapters/clearinghouse/stedi";
import { loadServerConfig } from "@/server/config";

describe("Stedi clearinghouse adapter", () => {
  it("authenticates a synthetic 270/271 request and summarizes active coverage", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe("test_secret");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        tradingPartnerServiceId: "87726",
        dependents: [{ firstName: "Jane", lastName: "Doe" }],
      });
      return new Response(
        JSON.stringify({
          id: "ec_test_1",
          meta: { applicationMode: "test" },
          tradingPartnerServiceId: "87726",
          errors: [],
          benefitsInformation: [
            { code: "1", name: "Active Coverage", planCoverage: "CHOICE PLUS" },
            { code: "C", name: "Deductible" },
          ],
          x12: "ISA*synthetic-271",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = createStediClient({
      apiKey: "test_secret",
      mode: "test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.checkEligibility(createStediMockEligibilityRequest());

    expect(result).toMatchObject({
      checkId: "ec_test_1",
      applicationMode: "test",
      activeCoverage: true,
      activeBenefitCount: 1,
      planNames: ["CHOICE PLUS"],
      hasRaw271: true,
      errors: [],
    });
  });

  it("forces professional claim submissions to X12 test usage", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        claimInformation: { patientControlNumber: "CLM-1" },
        usageIndicator: "T",
      });
      return new Response(JSON.stringify({ claimReference: "test-claim-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createStediClient({
      apiKey: "test_secret",
      mode: "test",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.submitProfessionalClaim({
      claimInformation: { patientControlNumber: "CLM-1" },
      usageIndicator: "P",
    });
  });

  it("fails closed on account-mode denial without exposing remote details or credentials", async () => {
    const client = createStediClient({
      apiKey: "never-log-this-secret",
      mode: "test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: "access_denied",
            message: "Access Denied - This functionality is not available in Test Mode.",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(client.submitProfessionalClaim({})).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
    } satisfies Partial<StediApiError>);
    await expect(client.submitProfessionalClaim({})).rejects.not.toThrow(
      /never-log-this-secret/,
    );
  });

  it("requires a server-only key when Stedi test mode is enabled", () => {
    expect(() =>
      loadServerConfig({ STEDI_MODE: "test" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/STEDI_API_KEY/);
    expect(
      loadServerConfig({
        STEDI_MODE: "test",
        STEDI_API_KEY: "test_secret",
      } as unknown as NodeJS.ProcessEnv).stediMode,
    ).toBe("test");
  });
});
