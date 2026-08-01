import type {
  Bundle,
  Claim,
  ClaimResponse,
  Coverage,
  Encounter,
  Organization,
  Patient,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { evaluateDiscrepancies } from "@/domain/discrepancy";
import type {
  ClaimEpisode,
  DemoSnapshot,
  EvidenceItem,
  ObservationSource,
  SourceObservation,
} from "@/domain/types";
import { getDemoClock } from "@/domain/clock";
import type { HealthcareRepository } from "./local";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const SUPPORTED = new Set([
  "Patient",
  "Encounter",
  "Coverage",
  "Organization",
  "ChargeItem",
  "Claim",
  "ClaimResponse",
  "PaymentReconciliation",
  "DocumentReference",
  "Task",
  "Provenance",
  "AuditEvent",
  "Condition",
]);

function refId(reference?: string): string | undefined {
  if (!reference) return undefined;
  const parts = reference.split("/");
  return parts[parts.length - 1];
}

function patientName(patient?: Patient): string {
  const text = patient?.name?.[0]?.text;
  if (text) return text;
  const given = patient?.name?.[0]?.given?.join(" ") ?? "";
  const family = patient?.name?.[0]?.family ?? "";
  const combined = `${given} ${family}`.trim();
  return combined || `Patient/${patient?.id ?? "unknown"}`;
}

function mapAdjudication(
  status?: string,
): ClaimEpisode["adjudicationState"] {
  const value = (status ?? "").toLowerCase();
  if (value.includes("complete") || value === "active") return "paid";
  if (value.includes("denied") || value.includes("error")) return "denied";
  if (value.includes("partial")) return "partial";
  if (value.includes("pended") || value.includes("pending")) return "pending";
  if (value) return "accepted_for_processing";
  return "not_found";
}

/**
 * Medplum healthcare read adapter.
 * Authenticates with OAuth client credentials and maps FHIR Bundle resources
 * into ClaimEpisode projections without importing local seed fixtures.
 */
export function createMedplumHealthcareRepository(input: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  fetchImpl?: FetchLike;
}): HealthcareRepository & {
  authenticate: () => Promise<string>;
  fetchBundle: (accessToken: string) => Promise<Bundle>;
  mapBundleToSnapshot: (bundle: Bundle) => DemoSnapshot;
} {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/$/, "");

  async function authenticate(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
    let response: Response;
    try {
      response = await fetchImpl(`${base}/oauth2/token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch (error) {
      throw Object.assign(new Error(sanitizeMedplumError(error).message), {
        status: 503,
        code: "MEDPLUM_UNAVAILABLE",
      });
    }
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `Medplum auth failed with ${response.status}. Local synthetic fixtures were not used.`,
        ),
        { status: 503, code: "MEDPLUM_AUTH_FAILED" },
      );
    }
    const json = (await response.json()) as { access_token?: string };
    if (!json.access_token) {
      throw Object.assign(
        new Error("Medplum auth response missing access_token"),
        { status: 502, code: "MEDPLUM_INVALID_RESPONSE" },
      );
    }
    return json.access_token;
  }

  async function fetchBundle(accessToken: string): Promise<Bundle> {
    const url = `${base}/fhir/R4/Patient?_count=50&_revinclude=Encounter:subject&_revinclude=Coverage:beneficiary&_revinclude=Claim:patient&_revinclude=Task:patient&_revinclude=DocumentReference:subject&_revinclude=ChargeItem:subject&_revinclude=Condition:subject&_revinclude=ClaimResponse:patient&_revinclude=PaymentReconciliation:patient&_revinclude=Provenance:target&_revinclude=AuditEvent:patient&_include=Claim:insurer&_include=Coverage:payor&_project=${encodeURIComponent(input.projectId)}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/fhir+json",
          authorization: `Bearer ${accessToken}`,
        },
      });
    } catch (error) {
      throw Object.assign(new Error(sanitizeMedplumError(error).message), {
        status: 503,
        code: "MEDPLUM_UNAVAILABLE",
      });
    }
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `Medplum FHIR read failed with ${response.status}. Local synthetic fixtures were not used.`,
        ),
        { status: 503, code: "MEDPLUM_READ_FAILED" },
      );
    }
    const json = (await response.json()) as Bundle;
    if (json.resourceType !== "Bundle" || !Array.isArray(json.entry)) {
      throw Object.assign(
        new Error("Medplum returned a malformed FHIR Bundle"),
        { status: 502, code: "MEDPLUM_INVALID_RESPONSE" },
      );
    }
    return json;
  }

  function mapBundleToSnapshot(bundle: Bundle): DemoSnapshot {
    const resources = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter(Boolean) as Resource[];

    for (const resource of resources) {
      if (!SUPPORTED.has(resource.resourceType)) {
        // Unsupported unrelated types are ignored safely.
        continue;
      }
    }

    const byType = <T extends Resource>(type: T["resourceType"]): T[] =>
      resources.filter((r) => r.resourceType === type) as T[];

    const patients = byType<Patient>("Patient");
    if (patients.length === 0) {
      throw Object.assign(
        new Error("Medplum Bundle contained no Patient resources to map"),
        { status: 502, code: "MEDPLUM_MAPPING_FAILED" },
      );
    }

    const patientById = new Map(patients.map((p) => [p.id!, p]));
    const orgs = byType<Organization>("Organization");
    const orgById = new Map(orgs.map((o) => [o.id!, o]));
    const coverages = byType<Coverage>("Coverage");
    const encounters = byType<Encounter>("Encounter");
    const claims = byType<Claim>("Claim");
    const claimResponses = byType<ClaimResponse>("ClaimResponse");
    const payments = byType<PaymentReconciliation>("PaymentReconciliation");
    const tasks = byType<Task>("Task");
    const docs = resources.filter(
      (r) => r.resourceType === "DocumentReference",
    ) as Array<{
      resourceType: "DocumentReference";
      id?: string;
      description?: string;
      date?: string;
      subject?: { reference?: string };
    }>;
    const chargeItems = resources.filter(
      (r) => r.resourceType === "ChargeItem",
    ) as Array<{
      resourceType: "ChargeItem";
      id?: string;
      subject?: { reference?: string };
      code?: { coding?: Array<{ code?: string; display?: string }> };
      quantity?: { value?: number };
      priceOverride?: { value?: number };
      context?: { reference?: string };
    }>;
    const provenances = byType<Resource>("Provenance");
    const audits = byType<Resource>("AuditEvent");

    const claimedEncounterIds = new Set<string>();
    const episodes: ClaimEpisode[] = [];
    const now = getDemoClock();

    function docsForPatient(patientId: string): EvidenceItem[] {
      return docs
        .filter((doc) => refId(doc.subject?.reference) === patientId)
        .map((doc, index) => {
          const description = doc.description ?? "";
          const lower = description.toLowerCase();
          return {
            id: `medplum-doc-${doc.id ?? index}`,
            title: description || `DocumentReference/${doc.id}`,
            kind: lower.includes("835")
              ? ("raw_835" as const)
              : lower.includes("277")
                ? ("raw_277" as const)
                : ("portal_snapshot" as const),
            reference: `DocumentReference/${doc.id ?? index}`,
            summary: `${description || "Medplum document"} [connected read; raw 277/835 remain DocumentReference]`,
            synthetic: false,
            observedAt: doc.date ?? now,
          };
        });
    }

    function coverageForPatient(patientId: string): Coverage | undefined {
      return coverages.find(
        (c) => refId(c.beneficiary?.reference) === patientId,
      );
    }

    function payerName(coverage?: Coverage, claim?: Claim): string {
      const payorRef =
        claim?.insurer?.reference ??
        coverage?.payor?.[0]?.reference ??
        coverage?.payor?.[0]?.display;
      if (payorRef && payorRef.includes("/")) {
        const org = orgById.get(refId(payorRef) ?? "");
        return org?.name ?? payorRef;
      }
      return (
        coverage?.payor?.[0]?.display ??
        claim?.insurer?.display ??
        "Connected payer"
      );
    }

    for (const claim of claims) {
      if (!claim.id) {
        throw Object.assign(
          new Error("Claim resource missing id"),
          { status: 502, code: "MEDPLUM_MAPPING_FAILED" },
        );
      }
      const patientId = refId(claim.patient?.reference);
      if (!patientId || !patientById.has(patientId)) {
        throw Object.assign(
          new Error(`Claim/${claim.id} missing linked Patient`),
          { status: 502, code: "MEDPLUM_MAPPING_FAILED" },
        );
      }
      const patient = patientById.get(patientId)!;
      const encounterRef = claim.item?.[0]?.encounter?.[0]?.reference;
      const encounterId = refId(encounterRef);
      if (encounterId) claimedEncounterIds.add(encounterId);
      const encounter = encounters.find((e) => e.id === encounterId);
      const coverage = coverageForPatient(patientId);
      const response = claimResponses.find(
        (r) => refId(r.request?.reference) === claim.id,
      );
      const payment = payments.find((p) => {
        const pay = p as PaymentReconciliation & {
          payment?: { amount?: { value?: number }; identifier?: { value?: string } };
        };
        return (
          pay.payment?.identifier?.value === claim.id ||
          p.detail?.some((d) => refId(d.request?.reference) === claim.id)
        );
      }) as
        | (PaymentReconciliation & {
            payment?: {
              amount?: { value?: number };
              identifier?: { value?: string };
            };
          })
        | undefined;
      const task = tasks.find(
        (t) =>
          refId(t.for?.reference) === patientId ||
          refId(t.focus?.reference) === claim.id,
      );
      const relatedCharges = chargeItems.filter(
        (c) =>
          refId(c.subject?.reference) === patientId ||
          (encounterId && refId(c.context?.reference) === encounterId),
      );
      const billed =
        claim.total?.value ??
        relatedCharges.reduce(
          (sum, c) => sum + (c.priceOverride?.value ?? 0),
          0,
        );
      const paid = payment?.payment?.amount?.value ?? null;
      const adjudication = mapAdjudication(
        response?.status ?? payment?.status ?? claim.status,
      );
      const remittanceState = payment ? "received" : "none";
      const postingState =
        paid != null && remittanceState === "received"
          ? "reconciled"
          : "unposted";

      const observations: SourceObservation[] = [];
      const pushObs = (
        source: ObservationSource,
        raw: string,
        normalized: string,
        evidenceReference: string,
      ) => {
        observations.push({
          id: `obs-${claim.id}-${source}`,
          episodeId: `episode-claim-${claim.id}`,
          source,
          rawStatus: raw,
          normalizedStatus: normalized,
          observedAt: claim.created ?? now,
          lastVerifiedAt: now,
          evidenceReference,
          synthetic: false,
        });
      };
      pushObs(
        "pms",
        claim.status ?? "active",
        adjudication,
        `Claim/${claim.id}`,
      );
      if (response) {
        pushObs(
          "payer",
          response.outcome ?? response.status ?? "unknown",
          adjudication,
          `ClaimResponse/${response.id}`,
        );
      }
      if (payment) {
        pushObs(
          "remittance",
          payment.status ?? "active",
          "paid",
          `PaymentReconciliation/${payment.id}`,
        );
      }

      const episode: ClaimEpisode = {
        id: `episode-claim-${claim.id}`,
        fixtureKey: "connected-claim",
        patientName: patientName(patient),
        patientId: `patient-${patientId}`,
        payerName: payerName(coverage, claim),
        payerId: coverage?.payor?.[0]?.reference ?? "org-connected",
        providerName:
          claim.provider?.display ??
          encounter?.participant?.[0]?.individual?.display ??
          "Connected provider",
        dateOfService:
          claim.billablePeriod?.start ??
          encounter?.period?.start?.slice(0, 10) ??
          now.slice(0, 10),
        claimId: claim.id.toUpperCase(),
        cpt:
          claim.item?.[0]?.productOrService?.coding?.[0]?.code ??
          relatedCharges[0]?.code?.coding?.[0]?.code ??
          null,
        billedAmount: billed ?? 0,
        encounterState:
          encounter?.status === "finished" ? "note_signed" : "completed",
        chargeState: "claim_created",
        transportState: "payer_delivered",
        adjudicationState: adjudication,
        remittanceState,
        settlementState: payment ? "received" : "unknown",
        postingState,
        resolutionState:
          task?.status === "requested"
            ? "approval_required"
            : adjudication === "denied"
              ? "investigating"
              : "monitoring",
        noteState: "final",
        codingReady: true,
        coverageActive: coverage?.status === "active",
        owner: task?.owner?.display ?? "Connected queue",
        issue: task?.description ?? claim.status ?? "Connected claim",
        agentAction: null,
        nextFollowUpAt: task?.restriction?.period?.end ?? null,
        lastPayerCheckAt: response?.created ?? null,
        lastVerifiedAt: now,
        revision: 1,
        observations,
        evidence: [
          ...docsForPatient(patientId),
          ...(provenances.length
            ? [
                {
                  id: `ev-prov-${claim.id}`,
                  title: "Connected Provenance",
                  kind: "authorization" as const,
                  reference: `Provenance/${provenances[0]?.id}`,
                  summary: "Provenance from Medplum Bundle",
                  synthetic: false,
                  observedAt: now,
                },
              ]
            : []),
        ],
        financial: {
          billed: billed ?? 0,
          allowed: null,
          paid,
          adjustment: null,
          patientResponsibility: null,
          posted: postingState === "reconciled" ? paid : null,
        },
        serviceLines: (claim.item ?? relatedCharges).map((item, index) => {
          const claimItem = item as {
            productOrService?: { coding?: Array<{ code?: string; display?: string }> };
            quantity?: { value?: number };
            unitPrice?: { value?: number };
            code?: { coding?: Array<{ code?: string; display?: string }> };
            priceOverride?: { value?: number };
          };
          return {
            id: `sl-${claim.id}-${index}`,
            cpt:
              claimItem.productOrService?.coding?.[0]?.code ??
              claimItem.code?.coding?.[0]?.code ??
              "unknown",
            description:
              claimItem.productOrService?.coding?.[0]?.display ??
              claimItem.code?.coding?.[0]?.display ??
              "Connected service",
            units: claimItem.quantity?.value ?? 1,
            charge:
              claimItem.unitPrice?.value ??
              claimItem.priceOverride?.value ??
              0,
            diagnosisPointers: ["1"],
          };
        }),
        diagnoses: [],
        discrepancies: [],
        proposal: null,
        activities: [],
        submissionReceiptId: response?.id
          ? `ClaimResponse/${response.id}`
          : null,
        reprocessingReceiptId: null,
        remittanceControlNumber: payment?.payment?.identifier?.value ?? null,
        claimControlNumber: claim.identifier?.[0]?.value ?? claim.id,
        fhirResources: [
          ...provenances,
          ...audits,
        ] as unknown as Array<Record<string, unknown>>,
      };
      episode.discrepancies = evaluateDiscrepancies(episode);
      episodes.push(episode);
    }

    for (const encounter of encounters) {
      if (!encounter.id || claimedEncounterIds.has(encounter.id)) continue;
      const patientId = refId(encounter.subject?.reference);
      if (!patientId || !patientById.has(patientId)) {
        throw Object.assign(
          new Error(`Encounter/${encounter.id} missing linked Patient`),
          { status: 502, code: "MEDPLUM_MAPPING_FAILED" },
        );
      }
      const patient = patientById.get(patientId)!;
      const coverage = coverageForPatient(patientId);
      const relatedCharges = chargeItems.filter(
        (c) =>
          refId(c.context?.reference) === encounter.id ||
          refId(c.subject?.reference) === patientId,
      );
      const billed = relatedCharges.reduce(
        (sum, c) => sum + (c.priceOverride?.value ?? 0),
        0,
      );
      const episode: ClaimEpisode = {
        id: `episode-encounter-${encounter.id}`,
        fixtureKey: "connected-encounter",
        patientName: patientName(patient),
        patientId: `patient-${patientId}`,
        payerName: payerName(coverage),
        payerId: coverage?.payor?.[0]?.reference ?? "org-connected",
        providerName:
          encounter.participant?.[0]?.individual?.display ??
          "Connected provider",
        dateOfService: encounter.period?.start?.slice(0, 10) ?? now.slice(0, 10),
        claimId: null,
        cpt: relatedCharges[0]?.code?.coding?.[0]?.code ?? null,
        billedAmount: billed || 0,
        encounterState:
          encounter.status === "finished" ? "note_signed" : "completed",
        chargeState: relatedCharges.length ? "ready" : "uncoded",
        transportState: "unsent",
        adjudicationState: "not_found",
        remittanceState: "none",
        settlementState: "unknown",
        postingState: "unposted",
        resolutionState: relatedCharges.length
          ? "approval_required"
          : "waiting_on_practice",
        noteState: encounter.status === "finished" ? "final" : "draft",
        codingReady: relatedCharges.length > 0,
        coverageActive: coverage?.status === "active",
        owner: "Connected queue",
        issue: "Connected encounter without claim",
        agentAction: null,
        nextFollowUpAt: null,
        lastPayerCheckAt: null,
        lastVerifiedAt: now,
        revision: 1,
        observations: [
          {
            id: `obs-enc-${encounter.id}`,
            episodeId: `episode-encounter-${encounter.id}`,
            source: "pms",
            rawStatus: encounter.status ?? "unknown",
            normalizedStatus: "ready_to_submit",
            observedAt: encounter.period?.end ?? now,
            lastVerifiedAt: now,
            evidenceReference: `Encounter/${encounter.id}`,
            synthetic: false,
          },
        ],
        evidence: docsForPatient(patientId),
        financial: {
          billed: billed || 0,
          allowed: null,
          paid: null,
          adjustment: null,
          patientResponsibility: null,
          posted: null,
        },
        serviceLines: relatedCharges.map((c, index) => ({
          id: `sl-enc-${encounter.id}-${index}`,
          cpt: c.code?.coding?.[0]?.code ?? "unknown",
          description: c.code?.coding?.[0]?.display ?? "Connected charge",
          units: c.quantity?.value ?? 1,
          charge: c.priceOverride?.value ?? 0,
          diagnosisPointers: ["1"],
        })),
        diagnoses: [],
        discrepancies: [],
        proposal: null,
        activities: [],
        submissionReceiptId: null,
        reprocessingReceiptId: null,
        remittanceControlNumber: null,
        claimControlNumber: null,
        fhirResources: [],
      };
      episode.discrepancies = evaluateDiscrepancies(episode);
      episodes.push(episode);
    }

    if (episodes.length === 0) {
      throw Object.assign(
        new Error("Medplum Bundle produced no Claim or Encounter episodes"),
        { status: 502, code: "MEDPLUM_MAPPING_FAILED" },
      );
    }

    return {
      demoClock: now,
      sessionRevision: 1,
      healthcareMode: "medplum",
      agentMode: "synthetic",
      episodes,
      events: [
        {
          type: "demo.session.reset",
          id: "event-medplum-read-1",
          at: now,
          sessionRevision: 1,
        },
      ],
      degraded: null,
    };
  }

  return {
    mode: "medplum",
    authenticate,
    fetchBundle,
    mapBundleToSnapshot,
    async readSnapshot(): Promise<DemoSnapshot> {
      const token = await authenticate();
      const bundle = await fetchBundle(token);
      return mapBundleToSnapshot(bundle);
    },
    describeLimitations() {
      return [
        "Connected Medplum mode requires live credentials",
        "Current Stedi response integration stores raw 277 and 835 as DocumentReference",
        "Normalized adjudication ClaimResponse and PaymentReconciliation are not auto-created",
        "No silent fallback to local fixtures",
        "Connected writes are out of scope in this demo",
        "Connected projections are built only from Bundle resources",
      ];
    },
  };
}

export function sanitizeMedplumError(error: unknown): {
  message: string;
  status: number;
} {
  const raw = error instanceof Error ? error.message : "Medplum error";
  const message = raw
    .replace(
      /(client[_-]?secret|access[_-]?token|bearer)\s*[:=]?\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/sk_[A-Za-z0-9]+/g, "[redacted]");
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status: number }).status)
      : 503;
  return { message, status };
}
