import { describe, expect, it } from "vitest";
import {
  assertFhirResourceValid,
  classifyFhirPlaneStatus,
  deriveFhirResourceId,
  FhirPlaneValidationError,
  PAYER_WRITES_MODE,
  probeFhirPlane,
  sessionLedgerBackend,
  writeFhirResourceIdempotent,
} from "@/server/fhir-plane";
import { getHarborviewEnv, setHarborviewEnv } from "@/server/bindings";

describe("session ledger backend", () => {
  it("reports memory when no D1 binding is present, d1 once one is injected", () => {
    const previous = getHarborviewEnv();
    setHarborviewEnv({});
    expect(sessionLedgerBackend()).toBe("memory");
    setHarborviewEnv({ DB: {} as never });
    expect(sessionLedgerBackend()).toBe("d1");
    setHarborviewEnv(previous);
  });
});

describe("payer writes are always simulated", () => {
  it("exposes a constant badge value", () => {
    expect(PAYER_WRITES_MODE).toBe("simulated");
  });
});

describe("FHIR-plane status classification (pure, no I/O)", () => {
  it("is disabled outside medplum mode or without configured credentials", () => {
    expect(
      classifyFhirPlaneStatus({ healthcareMode: "local", medplumConfigured: true }),
    ).toBe("disabled");
    expect(
      classifyFhirPlaneStatus({ healthcareMode: "medplum", medplumConfigured: false }),
    ).toBe("disabled");
  });

  it("is connected or unavailable only in medplum mode with credentials configured", () => {
    expect(
      classifyFhirPlaneStatus({
        healthcareMode: "medplum",
        medplumConfigured: true,
        connected: true,
      }),
    ).toBe("connected");
    expect(
      classifyFhirPlaneStatus({
        healthcareMode: "medplum",
        medplumConfigured: true,
        connected: false,
      }),
    ).toBe("unavailable");
  });
});

describe("probeFhirPlane", () => {
  it("is disabled without full credentials and never calls out", async () => {
    let called = false;
    const result = await probeFhirPlane(
      { medplumBaseUrl: "https://api.medplum.example" },
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    );
    expect(result.status).toBe("disabled");
    expect(called).toBe(false);
  });

  it("reports connected on a successful auth response and unavailable otherwise", async () => {
    const config = {
      medplumBaseUrl: "https://api.medplum.example",
      medplumClientId: "id",
      medplumClientSecret: "secret",
      medplumProjectId: "project",
    };
    const ok = await probeFhirPlane(config, async () =>
      new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    );
    expect(ok.status).toBe("connected");

    const rejected = await probeFhirPlane(config, async () => new Response("no", { status: 403 }));
    expect(rejected.status).toBe("unavailable");

    const unreachable = await probeFhirPlane(config, async () => {
      throw new Error("network down");
    });
    expect(unreachable.status).toBe("unavailable");
    expect(JSON.stringify(unreachable)).not.toContain("secret");
  });
});

describe("deriveFhirResourceId", () => {
  it("is deterministic and never contains the raw session id", () => {
    const sessionId = "sess-super-secret-cookie-value";
    const first = deriveFhirResourceId({
      sessionId,
      revision: 3,
      resourceType: "Provenance",
    });
    const second = deriveFhirResourceId({
      sessionId,
      revision: 3,
      resourceType: "Provenance",
    });
    expect(first).toBe(second);
    expect(first).not.toContain(sessionId);
    expect(first.startsWith("provenance-")).toBe(true);
  });

  it("differs by session id, revision, and resource type", () => {
    const base = { sessionId: "sess-a", revision: 1, resourceType: "Provenance" };
    const differentSession = deriveFhirResourceId({ ...base, sessionId: "sess-b" });
    const differentRevision = deriveFhirResourceId({ ...base, revision: 2 });
    const differentType = deriveFhirResourceId({ ...base, resourceType: "AuditEvent" });
    const original = deriveFhirResourceId(base);
    expect(differentSession).not.toBe(original);
    expect(differentRevision).not.toBe(original);
    expect(differentType).not.toBe(original);
  });
});

describe("assertFhirResourceValid", () => {
  it("rejects resource types outside the write-through allow-list", () => {
    expect(() =>
      assertFhirResourceValid({
        resourceType: "Patient",
        resource: {},
        sessionId: "sess-1",
      }),
    ).toThrow(FhirPlaneValidationError);
  });

  it("rejects a resourceType mismatch and raw session id leakage", () => {
    expect(() =>
      assertFhirResourceValid({
        resourceType: "Provenance",
        resource: { resourceType: "AuditEvent" },
        sessionId: "sess-1",
      }),
    ).toThrow(/resourceType/);

    expect(() =>
      assertFhirResourceValid({
        resourceType: "Provenance",
        resource: { note: "leaked sess-1 in a free-text field" },
        sessionId: "sess-1",
      }),
    ).toThrow(/raw session id/);
  });

  it("accepts a valid, minimal Provenance resource", () => {
    expect(() =>
      assertFhirResourceValid({
        resourceType: "Provenance",
        resource: {
          target: [{ reference: "Claim/CLM-EA-1001" }],
          recorded: "2026-08-01T00:00:00Z",
          agent: [{ who: { display: "Overturn synthetic agent" } }],
        },
        sessionId: "sess-1",
      }),
    ).not.toThrow();
  });

  it("rejects a structurally invalid resource via local R4 validation", () => {
    expect(() =>
      assertFhirResourceValid({
        resourceType: "Provenance",
        // agent is a 1..* required field on Provenance; omitting it must fail closed locally.
        resource: {
          target: [{ reference: "Claim/CLM-EA-1001" }],
          recorded: "2026-08-01T00:00:00Z",
        },
        sessionId: "sess-1",
      }),
    ).toThrow(FhirPlaneValidationError);
  });
});

describe("writeFhirResourceIdempotent", () => {
  it("PUTs to the derived id and reports idempotent=false on 201, true on 200", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      const status = calls.length === 1 ? 201 : 200;
      return new Response(JSON.stringify({ resourceType: "Provenance" }), { status });
    };
    const resource = {
      target: [{ reference: "Claim/CLM-EA-1001" }],
      recorded: "2026-08-01T00:00:00Z",
      agent: [{ who: { display: "Overturn synthetic agent" } }],
    };

    const first = await writeFhirResourceIdempotent({
      connection: {
        baseUrl: "https://api.medplum.example",
        accessToken: "tok",
        fetchImpl,
      },
      resourceType: "Provenance",
      resource,
      sessionId: "sess-1",
      revision: 5,
    });
    expect(first.idempotent).toBe(false);

    const second = await writeFhirResourceIdempotent({
      connection: {
        baseUrl: "https://api.medplum.example",
        accessToken: "tok",
        fetchImpl,
      },
      resourceType: "Provenance",
      resource,
      sessionId: "sess-1",
      revision: 5,
    });
    expect(second.idempotent).toBe(true);
    expect(second.id).toBe(first.id);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      `https://api.medplum.example/fhir/R4/Provenance/${first.id}`,
    );
    expect(calls[0]?.method).toBe("PUT");
  });

  it("never calls out when local validation fails", async () => {
    let called = false;
    await expect(
      writeFhirResourceIdempotent({
        connection: {
          baseUrl: "https://api.medplum.example",
          accessToken: "tok",
          fetchImpl: async () => {
            called = true;
            return new Response("{}", { status: 200 });
          },
        },
        resourceType: "Patient",
        resource: {},
        sessionId: "sess-1",
        revision: 1,
      }),
    ).rejects.toBeInstanceOf(FhirPlaneValidationError);
    expect(called).toBe(false);
  });

  it("fails closed on a non-OK response without leaking credentials", async () => {
    await expect(
      writeFhirResourceIdempotent({
        connection: {
          baseUrl: "https://api.medplum.example",
          accessToken: "never-log-this-token",
          fetchImpl: async () => new Response("denied", { status: 403 }),
        },
        resourceType: "Provenance",
        resource: {
          target: [{ reference: "Claim/CLM-EA-1001" }],
          recorded: "2026-08-01T00:00:00Z",
          agent: [{ who: { display: "Overturn synthetic agent" } }],
        },
        sessionId: "sess-1",
        revision: 1,
      }),
    ).rejects.toMatchObject({ status: 503, code: "FHIR_PLANE_WRITE_FAILED" });
  });
});
