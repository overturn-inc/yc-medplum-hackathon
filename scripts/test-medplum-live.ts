import "./_medplum-node-polyfills";
import { createMedplumHealthcareRepository } from "../src/adapters/healthcare/medplum";
import { probeFhirPlane, writeFhirResourceIdempotent } from "../src/server/fhir-plane";

const baseUrl = process.env.MEDPLUM_BASE_URL;
const clientId = process.env.MEDPLUM_CLIENT_ID;
const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
const projectId = process.env.MEDPLUM_PROJECT_ID;

const missing = (
  [
    ["MEDPLUM_BASE_URL", baseUrl],
    ["MEDPLUM_CLIENT_ID", clientId],
    ["MEDPLUM_CLIENT_SECRET", clientSecret],
    ["MEDPLUM_PROJECT_ID", projectId],
  ] as const
)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  throw new Error(
    `test:medplum:live requires ${missing.join(", ")}. This script never invents credentials -- ` +
      "configure them in .env.local (never committed) and re-run. FHIR-plane write-through is " +
      "optional; local verify never depends on this script.",
  );
}

const probe = await probeFhirPlane({
  medplumBaseUrl: baseUrl,
  medplumClientId: clientId,
  medplumClientSecret: clientSecret,
  medplumProjectId: projectId,
});
if (probe.status !== "connected") {
  throw new Error(`Medplum FHIR plane probe failed: ${probe.detail}`);
}

const medplum = createMedplumHealthcareRepository({
  baseUrl: baseUrl!,
  clientId: clientId!,
  clientSecret: clientSecret!,
  projectId: projectId!,
});
const accessToken = await medplum.authenticate();

// Fixed, script-only session id and revision: re-running this script always
// resolves to the same derived resource id, which is the point of the
// idempotent write-through helper under test. Never a real demo session.
const sessionId = "script:test-medplum-live";
const revision = 1;
const resource = {
  target: [{ reference: "Claim/CLM-EA-1001" }],
  recorded: new Date().toISOString(),
  agent: [{ who: { display: "Overturn FHIR-plane live smoke test (synthetic)" } }],
  reason: [{ text: "test:medplum:live write-through smoke test; safe to delete in Medplum" }],
};

const first = await writeFhirResourceIdempotent({
  connection: { baseUrl: baseUrl!, accessToken },
  resourceType: "Provenance",
  resource,
  sessionId,
  revision,
});
const second = await writeFhirResourceIdempotent({
  connection: { baseUrl: baseUrl!, accessToken },
  resourceType: "Provenance",
  resource,
  sessionId,
  revision,
});

if (second.id !== first.id) {
  throw new Error(
    `Idempotent write-through regression: retry landed on a different resource id (${first.id} vs ${second.id}).`,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    fhirPlane: probe.status,
    write: first,
    retry: second,
    idempotentRetryConfirmed: second.idempotent === true,
  }),
);
