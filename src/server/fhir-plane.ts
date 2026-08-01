/**
 * FHIR-plane selection and idempotent write-through boundary.
 *
 * Two independent planes exist in this demo:
 *  - The session ledger (`@/server/repository`): durable per-session
 *    event/episode storage (D1 when the Worker has bound it, otherwise
 *    in-memory). It is always the source of truth for the demo UI.
 *  - The FHIR plane (Medplum): an optional, additive write-through target.
 *    Session state never depends on the FHIR plane succeeding; a disabled
 *    or unavailable FHIR plane only means synthetic FHIR resources are not
 *    also mirrored to a connected Medplum project.
 *
 * Payer-side writes (clearinghouse claim submission, appeal portal
 * submission, etc.) are always simulated in this demo -- see
 * `PAYER_WRITES_MODE` -- independent of both planes above.
 */
import { createHash } from "node:crypto";
import {
  indexStructureDefinitionBundle,
  tryGetDataType,
  validateResource,
} from "@medplum/core";
import { readJson } from "@medplum/definitions";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import { getD1Binding } from "@/server/bindings";

export type SessionLedgerBackend = "d1" | "memory";

/** Reflects the actual storage backend selected for this process/session, never a config guess. */
export function sessionLedgerBackend(): SessionLedgerBackend {
  return getD1Binding() ? "d1" : "memory";
}

/** This demo never places a real clearinghouse or payer-portal write; every such action is simulated. */
export const PAYER_WRITES_MODE = "simulated" as const;

export type FhirPlaneStatus = "disabled" | "connected" | "unavailable";

/**
 * Pure classification of the FHIR-plane badge from already-known facts.
 * Deliberately does not perform network I/O itself, so it is safe to call on
 * every render: `connected` should only be passed once a real Medplum read
 * or write has actually succeeded elsewhere in the request.
 */
export function classifyFhirPlaneStatus(input: {
  healthcareMode: "local" | "medplum";
  medplumConfigured: boolean;
  connected?: boolean;
}): FhirPlaneStatus {
  if (input.healthcareMode !== "medplum") return "disabled";
  if (!input.medplumConfigured) return "disabled";
  return input.connected ? "connected" : "unavailable";
}

/** Resource types this demo will ever write through to the FHIR plane. Mirrors the Medplum read adapter's SUPPORTED set. */
const FHIR_PLANE_WRITABLE_TYPES = new Set([
  "Provenance",
  "AuditEvent",
  "DocumentReference",
  "Task",
  "Claim",
  "Coverage",
]);

export class FhirPlaneValidationError extends Error {
  readonly status = 400;
  readonly code = "FHIR_PLANE_INVALID_RESOURCE";
  constructor(message: string) {
    super(message);
    this.name = "FhirPlaneValidationError";
  }
}

let typesIndexed = false;

/** Lazily indexes the R4 StructureDefinitions once per process so `validateResource` works standalone. */
function ensureFhirTypesIndexed(): void {
  if (typesIndexed) return;
  for (const file of ["fhir/r4/profiles-types.json", "fhir/r4/profiles-resources.json"]) {
    const bundle = readJson(file) as Bundle;
    if (file.includes("profiles-types")) {
      indexStructureDefinitionBundle(bundle);
      continue;
    }
    const filtered: Bundle = {
      ...bundle,
      entry: (bundle.entry ?? []).filter((entry) => {
        const resource = entry.resource as Resource | undefined;
        if (!resource || resource.resourceType !== "StructureDefinition") return false;
        const typeName = (resource as { type?: string }).type;
        return typeName ? FHIR_PLANE_WRITABLE_TYPES.has(typeName) : false;
      }),
    };
    indexStructureDefinitionBundle(filtered);
  }
  typesIndexed = true;
}

/**
 * Local, offline validation against the real R4 StructureDefinitions (no
 * network round trip). Runs before every write-through attempt so a
 * malformed resource never reaches Medplum, and fails closed rather than
 * silently accepting an invalid payload.
 *
 * Also enforces the write-through boundary invariants:
 *  - `resourceType` is on the small allow-list this demo ever writes.
 *  - the resource body never embeds the raw session id (only the derived,
 *    non-reversible resource id may reference the session).
 */
export function assertFhirResourceValid(input: {
  resourceType: string;
  resource: Record<string, unknown>;
  sessionId: string;
}): void {
  if (!FHIR_PLANE_WRITABLE_TYPES.has(input.resourceType)) {
    throw new FhirPlaneValidationError(
      `${input.resourceType} is not on the FHIR-plane write-through allow-list.`,
    );
  }
  if (
    "resourceType" in input.resource &&
    input.resource.resourceType !== input.resourceType
  ) {
    throw new FhirPlaneValidationError(
      `Resource declares resourceType ${String(input.resource.resourceType)} but ${input.resourceType} was expected.`,
    );
  }
  if (JSON.stringify(input.resource).includes(input.sessionId)) {
    throw new FhirPlaneValidationError(
      "FHIR resource content must never embed the raw session id.",
    );
  }

  ensureFhirTypesIndexed();
  if (!tryGetDataType(input.resourceType)) {
    throw new FhirPlaneValidationError(
      `Unknown FHIR R4 resource type: ${input.resourceType}.`,
    );
  }
  const candidate = { ...input.resource, resourceType: input.resourceType } as Resource;
  let issues: ReturnType<typeof validateResource>;
  try {
    issues = validateResource(candidate);
  } catch (error) {
    throw new FhirPlaneValidationError(
      `Local FHIR validation threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new FhirPlaneValidationError(
      `Local FHIR validation failed: ${errors
        .map((issue) => issue.details?.text ?? issue.code)
        .join("; ")}`,
    );
  }
}

/**
 * Derives a deterministic, non-reversible FHIR resource id from the session
 * id, the episode/session revision, and the resource type. The raw session
 * cookie value is never itself used as, or embedded in, a FHIR resource id.
 */
export function deriveFhirResourceId(input: {
  sessionId: string;
  revision: number;
  resourceType: string;
}): string {
  const digest = createHash("sha256")
    .update(`overturn-fhir-plane:${input.resourceType}:${input.sessionId}:${input.revision}`)
    .digest("hex");
  return `${input.resourceType.toLowerCase()}-${digest.slice(0, 32)}`;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MedplumConnection {
  baseUrl: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}

/**
 * Probes Medplum client-credentials auth only; never reads or writes
 * clinical data. Used solely to report the `connected` / `unavailable`
 * badge, and safe to call from a background/health-check path -- callers
 * must not run this synchronously on every page render (see
 * `classifyFhirPlaneStatus`, which takes an already-known `connected` flag
 * instead).
 */
export async function probeFhirPlane(
  config: {
    medplumBaseUrl?: string;
    medplumClientId?: string;
    medplumClientSecret?: string;
    medplumProjectId?: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<{ status: FhirPlaneStatus; detail: string }> {
  if (
    !config.medplumBaseUrl ||
    !config.medplumClientId ||
    !config.medplumClientSecret ||
    !config.medplumProjectId
  ) {
    return { status: "disabled", detail: "Medplum credentials are not configured." };
  }
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.medplumClientId,
      client_secret: config.medplumClientSecret,
    });
    const response = await fetchImpl(
      `${config.medplumBaseUrl.replace(/\/$/, "")}/oauth2/token`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      return {
        status: "unavailable",
        detail: `Medplum auth responded with HTTP ${response.status}.`,
      };
    }
    const json = (await response.json().catch(() => null)) as { access_token?: string } | null;
    if (!json?.access_token) {
      return { status: "unavailable", detail: "Medplum auth response was missing an access token." };
    }
    return { status: "connected", detail: "Medplum FHIR plane is reachable." };
  } catch {
    return { status: "unavailable", detail: "Medplum FHIR plane is unreachable." };
  }
}

export interface FhirWriteThroughResult {
  id: string;
  resourceType: string;
  /** True when this write landed on an id that already existed (safe retry), false on first creation. */
  idempotent: boolean;
}

/**
 * Idempotent write-through to the FHIR plane. The resource id is fully
 * determined by (resourceType, sessionId, revision), so retrying the
 * identical logical write is always a conditional PUT to the same id --
 * Medplum treats this as an update-in-place, never a duplicate resource.
 * Validates locally (see `assertFhirResourceValid`) before ever calling out.
 */
export async function writeFhirResourceIdempotent(input: {
  connection: MedplumConnection;
  resourceType: string;
  resource: Record<string, unknown>;
  sessionId: string;
  revision: number;
}): Promise<FhirWriteThroughResult> {
  assertFhirResourceValid({
    resourceType: input.resourceType,
    resource: input.resource,
    sessionId: input.sessionId,
  });

  const id = deriveFhirResourceId({
    sessionId: input.sessionId,
    revision: input.revision,
    resourceType: input.resourceType,
  });
  const fetchImpl = input.connection.fetchImpl ?? fetch;
  const base = input.connection.baseUrl.replace(/\/$/, "");
  const body = { ...input.resource, resourceType: input.resourceType, id };

  let response: Response;
  try {
    response = await fetchImpl(`${base}/fhir/R4/${input.resourceType}/${id}`, {
      method: "PUT",
      headers: {
        accept: "application/fhir+json",
        "content-type": "application/fhir+json",
        authorization: `Bearer ${input.connection.accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw Object.assign(new Error("Medplum FHIR plane write is unavailable."), {
      status: 503,
      code: "FHIR_PLANE_UNAVAILABLE",
    });
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(`Medplum FHIR plane write failed with HTTP ${response.status}.`),
      {
        status: response.status === 401 || response.status === 403 ? 503 : 502,
        code: "FHIR_PLANE_WRITE_FAILED",
      },
    );
  }

  // Medplum (like most FHIR servers) returns 201 on first creation of a
  // conditional/`PUT`-with-id resource and 200 when updating one that
  // already exists -- exactly the idempotent-retry signal we want.
  return { id, resourceType: input.resourceType, idempotent: response.status === 200 };
}
