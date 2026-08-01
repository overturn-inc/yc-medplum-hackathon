import type {
  Bundle,
  BundleEntry,
  Claim,
  ClaimResponse,
  Coverage,
  DocumentReference,
  Encounter,
  Organization,
  Patient,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { evaluateDiscrepancies } from "@/domain/discrepancy";
import { isVerifiedPaid } from "@/domain/verified-paid";
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

/**
 * Base adjudication mapping from claim/payer-reported signals only.
 * NEVER maps ClaimResponse.outcome === "complete" or Claim.status === "active"
 * to "paid": those mean the payer processed or queued a response, not that
 * payment was made. "paid" is only ever set later, after independently
 * verified remittance + posting evidence exists (see isVerifiedPaid below).
 */
function mapAdjudicationBase(
  claim: Claim,
  response: ClaimResponse | undefined,
): ClaimEpisode["adjudicationState"] {
  if (response) {
    if (response.outcome === "error") return "denied";
    if (response.outcome === "partial") return "partial";
    // "complete" or "queued": payer processed/queued the request only.
    return "accepted_for_processing";
  }
  if (claim.status === "cancelled" || claim.status === "entered-in-error") {
    return "not_found";
  }
  return "accepted_for_processing";
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

  async function fetchFhirSearch(
    url: string,
    accessToken: string,
  ): Promise<Bundle> {
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

  async function fetchBundle(accessToken: string): Promise<Bundle> {
    // PaymentReconciliation:patient is not a valid R4 _revinclude (there is
    // no "patient" search parameter on PaymentReconciliation), so it is
    // never requested here. Claim/ClaimResponse/DocumentReference/Task are
    // still fetched via valid revincludes off the primary Patient search.
    const patientUrl = `${base}/fhir/R4/Patient?_count=50&_revinclude=Encounter:subject&_revinclude=Coverage:beneficiary&_revinclude=Claim:patient&_revinclude=Task:patient&_revinclude=DocumentReference:subject&_revinclude=ChargeItem:subject&_revinclude=Condition:subject&_revinclude=ClaimResponse:patient&_revinclude=Provenance:target&_revinclude=AuditEvent:patient&_include=Claim:insurer&_include=Coverage:payor&_project=${encodeURIComponent(input.projectId)}`;
    const patientBundle = await fetchFhirSearch(patientUrl, accessToken);

    // PaymentReconciliation has no patient- or claim-scoped R4 search
    // parameter, so it is fetched as its own project-scoped search and
    // linked to a specific claim only via exact detail.request/response
    // references during mapping (never via patient-wide inference).
    const paymentUrl = `${base}/fhir/R4/PaymentReconciliation?_count=50&_project=${encodeURIComponent(input.projectId)}`;
    const paymentBundle = await fetchFhirSearch(paymentUrl, accessToken);

    const entry: BundleEntry[] = [
      ...(patientBundle.entry ?? []),
      ...(paymentBundle.entry ?? []),
    ];
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry,
    };
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
    const coverageById = new Map(coverages.map((c) => [c.id!, c]));
    const encounters = byType<Encounter>("Encounter");
    const claims = byType<Claim>("Claim");
    const claimResponses = byType<ClaimResponse>("ClaimResponse");
    const payments = byType<PaymentReconciliation>("PaymentReconciliation");
    const tasks = byType<Task>("Task");
    const docs = byType<DocumentReference>("DocumentReference");
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

    /**
     * Exact-linkage document lookup. When `claim` is given, a document is
     * attached ONLY when its `context.related` points at exactly this Claim
     * or its ClaimResponse, or -- when it has no related links at all -- its
     * own identifier exactly matches this claim's control number. There is
     * deliberately NO encounter-wide fallback here: multiple claims can
     * share one encounter, and an encounter-only link can't tell them
     * apart, so it would risk attaching one claim's evidence to another.
     * When `claim` is undefined (a connected encounter with no claim yet),
     * the encounter link is the only linkage available and is used as-is.
     */
    function docsForClaim(
      claim: Claim | undefined,
      response: ClaimResponse | undefined,
      encounterId: string | undefined,
      patientId: string,
    ): Array<{ raw: DocumentReference; evidence: EvidenceItem }> {
      const claimControlNumber = claim?.identifier?.[0]?.value;
      return docs
        .filter((doc) => {
          if (refId(doc.subject?.reference) !== patientId) return false;
          const related = (doc.context?.related ?? [])
            .map((r) => refId(r.reference))
            .filter(Boolean) as string[];
          if (claim) {
            if (related.includes(claim.id!)) return true;
            if (response?.id && related.includes(response.id)) return true;
            if (related.length > 0) return false;
            if (claimControlNumber) {
              return (doc.identifier ?? []).some(
                (id) => id.value === claimControlNumber,
              );
            }
            return false;
          }
          return !!encounterId && related.includes(encounterId);
        })
        .map((doc, index) => {
          const description = doc.description ?? "";
          const lower = description.toLowerCase();
          const kind = lower.includes("835")
            ? ("raw_835" as const)
            : lower.includes("277")
              ? ("raw_277" as const)
              : lower.includes("posting")
                ? ("pms_posting" as const)
                : ("portal_snapshot" as const);
          const evidence: EvidenceItem = {
            id: `medplum-doc-${doc.id ?? index}`,
            title: description || `DocumentReference/${doc.id}`,
            kind,
            reference: `DocumentReference/${doc.id ?? index}`,
            summary: `${description || "Medplum document"} [connected read; raw 277/835 remain DocumentReference]`,
            synthetic: false,
            observedAt: doc.date ?? now,
          };
          return { raw: doc, evidence };
        });
    }

    function coverageForPatient(patientId: string): Coverage | undefined {
      return coverages.find(
        (c) => refId(c.beneficiary?.reference) === patientId,
      );
    }

    /**
     * Claim-scoped coverage: only `Claim.insurance.coverage` (focal
     * insurance first, else the first entry) counts. Deliberately NO
     * patient-wide fallback: when a claim doesn't specify its own coverage,
     * this returns undefined (coverageActive omitted) rather than risk
     * attaching a different claim's coverage from the same patient.
     */
    function coverageForClaim(claim: Claim): Coverage | undefined {
      const coverageRef =
        claim.insurance?.find((i) => i.focal)?.coverage?.reference ??
        claim.insurance?.[0]?.coverage?.reference;
      if (!coverageRef) return undefined;
      return coverageById.get(refId(coverageRef) ?? "");
    }

    /**
     * Parses a PMS posting DocumentReference's own JSON content (base64 in
     * `content[0].attachment.data`) for `controlNumber` and `postedAmount`.
     * Returns null on any missing/malformed content -- callers must never
     * treat an unparseable posting document as proof of posting, and must
     * never substitute the claim's paid amount for a missing postedAmount.
     */
    function parsePostingContent(
      doc: DocumentReference | undefined,
    ): { controlNumber: string; postedAmount: number } | null {
      const data = doc?.content?.[0]?.attachment?.data;
      if (!data) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object") return null;
      const controlNumber = (parsed as Record<string, unknown>).controlNumber;
      const postedAmount = (parsed as Record<string, unknown>).postedAmount;
      if (typeof controlNumber !== "string" || typeof postedAmount !== "number") {
        return null;
      }
      return { controlNumber, postedAmount };
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

    /** Only PaymentReconciliation whose detail.request/response references
     * THIS exact claim or claim response are considered; a resource that
     * only references another claim is rejected, never applied here. */
    function paymentForClaim(
      claim: Claim,
      response: ClaimResponse | undefined,
    ): PaymentReconciliation | undefined {
      return payments.find((p) =>
        (p.detail ?? []).some((d) => {
          const requestId = refId(d.request?.reference);
          const responseId = refId(d.response?.reference);
          return (
            requestId === claim.id ||
            (!!response && !!responseId && responseId === response.id)
          );
        }),
      );
    }

    /** Amount attributed to this specific claim: prefer the detail line's
     * own allocation; only fall back to the bulk paymentAmount when the
     * reconciliation has a single detail line naming this claim (so the
     * bulk total cannot be misattributed across multiple claims). */
    function paidAmountForClaim(
      payment: PaymentReconciliation | undefined,
      claim: Claim,
    ): number | null {
      if (!payment) return null;
      const detail = payment.detail ?? [];
      const matching = detail.find(
        (d) => refId(d.request?.reference) === claim.id,
      );
      if (matching?.amount?.value != null) return matching.amount.value;
      if (detail.length <= 1) return payment.paymentAmount?.value ?? null;
      return null;
    }

    /**
     * Task lookup requires an exact `Task.focus` match on this Claim (or, for
     * a pre-claim connected encounter, this Encounter). Deliberately NO
     * patient-wide fallback: an unfocused task can't tell which of several
     * claims for the same patient it belongs to, so it is never attached.
     */
    function taskForClaim(
      claim: Claim | undefined,
      encounterId: string | undefined,
    ): Task | undefined {
      return tasks.find((t) => {
        const focusId = refId(t.focus?.reference);
        if (!focusId) return false;
        return (
          (!!claim && focusId === claim.id) ||
          (!claim && !!encounterId && focusId === encounterId)
        );
      });
    }

    function provenanceForClaim(
      claim: Claim | undefined,
      encounterId: string | undefined,
    ): Resource | undefined {
      return provenances.find((p) => {
        const targets = (
          (p as unknown as { target?: Array<{ reference?: string }> })
            .target ?? []
        )
          .map((t) => refId(t.reference))
          .filter(Boolean) as string[];
        return (
          (!!claim && targets.includes(claim.id!)) ||
          (!!encounterId && targets.includes(encounterId))
        );
      });
    }

    function auditsForClaim(
      claim: Claim | undefined,
      encounterId: string | undefined,
    ): Resource[] {
      return audits.filter((a) => {
        const entities =
          (a as unknown as { entity?: Array<{ what?: { reference?: string } }> })
            .entity ?? [];
        return entities.some((e) => {
          const id = refId(e.what?.reference);
          if (!id) return false;
          return (!!claim && id === claim.id) || (!!encounterId && id === encounterId);
        });
      });
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
      const coverage = coverageForClaim(claim);
      // Exact match only: ClaimResponse.request must reference THIS claim.
      const response = claimResponses.find(
        (r) => refId(r.request?.reference) === claim.id,
      );
      // Exact match only: rejects PaymentReconciliation resources whose
      // detail lines reference a different claim/claimResponse.
      const payment = paymentForClaim(claim, response);
      const task = taskForClaim(claim, encounterId);
      // Encounter/context-specific only; never a patient-wide charge scan.
      const relatedCharges = encounterId
        ? chargeItems.filter((c) => refId(c.context?.reference) === encounterId)
        : [];
      const billed =
        claim.total?.value ??
        relatedCharges.reduce(
          (sum, c) => sum + (c.priceOverride?.value ?? 0),
          0,
        );
      const paid = paidAmountForClaim(payment, claim);
      const remittanceState = payment ? "received" : "none";
      const claimControlNumber = claim.identifier?.[0]?.value ?? claim.id;
      const claimDocsWithRaw = docsForClaim(claim, response, encounterId, patientId);
      const claimDocs = claimDocsWithRaw.map((d) => d.evidence);
      const postingDocWithRaw = claimDocsWithRaw.find(
        (d) => d.evidence.kind === "pms_posting",
      );
      const postingDoc = postingDocWithRaw?.evidence;
      // Parse the posting document's OWN content for its control number and
      // posted amount; never derive `posted` from `paid`. Reconciled only
      // when the content parses AND its control number exactly matches this
      // claim's control number -- a posting document that merely exists (or
      // is empty/malformed, or claims a different claim's control number) is
      // never accepted as PMS posting proof.
      const postingContent = parsePostingContent(postingDocWithRaw?.raw);
      const postingState =
        postingContent && postingContent.controlNumber === claimControlNumber
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
      const adjudication = mapAdjudicationBase(claim, response);
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
        // Remittance receipt only; "received" (not "paid") until posting
        // is independently reconciled below.
        pushObs(
          "remittance",
          payment.status ?? "active",
          "received",
          `PaymentReconciliation/${payment.id}`,
        );
      }
      if (postingDoc && postingState === "reconciled") {
        pushObs("posting", "Posted", "reconciled", postingDoc.reference);
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
          ...claimDocs,
          ...(provenanceForClaim(claim, encounterId)
            ? [
                {
                  id: `ev-prov-${claim.id}`,
                  title: "Connected Provenance",
                  kind: "authorization" as const,
                  reference: `Provenance/${provenanceForClaim(claim, encounterId)!.id}`,
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
          posted: postingState === "reconciled" ? postingContent!.postedAmount : null,
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
        remittanceControlNumber: payment?.paymentIdentifier?.value ?? null,
        claimControlNumber,
        fhirResources: auditsForClaim(claim, encounterId) as unknown as Array<
          Record<string, unknown>
        >,
      };
      episode.discrepancies = evaluateDiscrepancies(episode);
      // "paid" is only set once independent remittance + posting evidence
      // is verified; otherwise the payer/PMS-reported adjudication stands.
      if (isVerifiedPaid(episode)) {
        episode.adjudicationState = "paid";
        episode.settlementState = "received";
        episode.discrepancies = evaluateDiscrepancies(episode);
      }
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
      // Encounter-scoped only; never a patient-wide charge scan (avoids
      // pulling another encounter's charges onto this one).
      const relatedCharges = chargeItems.filter(
        (c) => refId(c.context?.reference) === encounter.id,
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
        evidence: docsForClaim(undefined, undefined, encounter.id, patientId).map(
          (d) => d.evidence,
        ),
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
        "Evidence, tasks, and payments are linked only via exact claim/encounter references; no patient-wide fallback across multiple claims",
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
