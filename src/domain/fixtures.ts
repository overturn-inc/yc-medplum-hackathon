import type { Bundle, Resource } from "@medplum/fhirtypes";
import { getDemoClock, addDays } from "./clock";
import { buildReprocessingProposal, buildSubmitProposal } from "./proposals";
import { evaluateDiscrepancies } from "./discrepancy";
import type { ClaimEpisode } from "./types";

const PRACTICE_ID = "org-harborview-demo";
const DEMO_NOW = "2026-07-15T15:00:00.000Z";

function obs(
  episodeId: string,
  source: ClaimEpisode["observations"][number]["source"],
  rawStatus: string,
  normalizedStatus: string,
  observedAt: string,
  evidenceReference: string,
  index: number,
): ClaimEpisode["observations"][number] {
  return {
    id: `obs-${episodeId}-${source}-${index}`,
    episodeId,
    source,
    rawStatus,
    normalizedStatus,
    observedAt,
    lastVerifiedAt: observedAt,
    evidenceReference,
    synthetic: true,
  };
}

/**
 * Builds the R4 Claim resource for an episode's *current* claimId. When the
 * episode carries `correctedFromClaimId` (set by
 * `ActionService.executeCorrectAndResubmit`), the corrected claim links back
 * to the prior claim via `Claim.related` per R4 `ClaimRelated` --
 * `{ claim: Reference<Claim>, relationship: CodeableConcept }` -- using the
 * `http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship` code
 * `prior`. Exported so `ActionService` can snapshot the *original* claim
 * resource (by its original claimId, before the correction mutates the
 * episode) into `episode.fhirResources` -- both claims must appear in the
 * bundle.
 */
export function buildClaimResource(episode: ClaimEpisode): Resource | null {
  if (!episode.claimId) return null;
  return {
    resourceType: "Claim",
    id: episode.claimId.toLowerCase(),
    status: "active",
    type: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/claim-type",
          code: "professional",
        },
      ],
    },
    use: "claim",
    patient: { reference: `Patient/${episode.patientId.replace("patient-", "")}` },
    created: episode.lastVerifiedAt,
    provider: { display: episode.providerName },
    priority: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/processpriority",
          code: "normal",
        },
      ],
    },
    insurance: [
      {
        sequence: 1,
        focal: true,
        coverage: { reference: `Coverage/coverage-${episode.id}` },
      },
    ],
    item: episode.serviceLines.map((line, index) => ({
      sequence: index + 1,
      productOrService: {
        coding: [
          {
            system: "http://www.ama-assn.org/go/cpt",
            code: line.cpt,
            display: line.description,
          },
        ],
      },
      quantity: { value: line.units },
      unitPrice: { value: line.charge, currency: "USD" },
    })),
    total: { value: episode.billedAmount, currency: "USD" },
    ...(episode.correctedFromClaimId
      ? {
          related: [
            {
              claim: {
                reference: `Claim/${episode.correctedFromClaimId.toLowerCase()}`,
              },
              relationship: {
                coding: [
                  {
                    system:
                      "http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship",
                    code: "prior",
                  },
                ],
              },
            },
          ],
        }
      : {}),
  } as unknown as Resource;
}

function baseEpisode(
  partial: Omit<ClaimEpisode, "discrepancies" | "proposal" | "activities" | "fhirResources"> & {
    discrepancies?: ClaimEpisode["discrepancies"];
    proposal?: ClaimEpisode["proposal"];
    activities?: ClaimEpisode["activities"];
    fhirResources?: ClaimEpisode["fhirResources"];
  },
): ClaimEpisode {
  const episode: ClaimEpisode = {
    discrepancies: [],
    proposal: null,
    activities: [],
    fhirResources: [],
    ...partial,
  };
  episode.discrepancies = evaluateDiscrepancies(episode, DEMO_NOW);
  return episode;
}

export function createSeedEpisodes(now = DEMO_NOW): ClaimEpisode[] {
  const encounterA = baseEpisode({
    id: "episode-encounter-a",
    fixtureKey: "encounter-a",
    patientName: "Jane Doe",
    patientId: "patient-jane-doe",
    payerName: "UnitedHealthcare",
    payerId: "87726",
    providerName: "Dr. Jordan Blake",
    dateOfService: "2026-07-15",
    claimId: null,
    cpt: "99213",
    billedAmount: 185,
    encounterState: "note_signed",
    chargeState: "ready",
    transportState: "unsent",
    adjudicationState: "not_found",
    remittanceState: "none",
    settlementState: "unknown",
    postingState: "unposted",
    resolutionState: "approval_required",
    noteState: "final",
    codingReady: true,
    coverageActive: true,
    owner: "Alex Rivera",
    issue: "Ready for claim submission",
    agentAction: "Submit claim",
    nextFollowUpAt: null,
    lastPayerCheckAt: null,
    lastVerifiedAt: now,
    revision: 1,
    observations: [
      obs(
        "episode-encounter-a",
        "pms",
        "Encounter completed / note signed",
        "ready_to_submit",
        now,
        "Encounter/encounter-jane-doe",
        1,
      ),
    ],
    evidence: [
      {
        id: "ev-enc-a-note",
        title: "Signed progress note",
        kind: "note",
        reference: "Provenance/provenance-note-jane",
        summary: "Final signed note for office visit on 2026-07-15",
        synthetic: true,
        observedAt: now,
      },
    ],
    financial: {
      billed: 185,
      allowed: null,
      paid: null,
      adjustment: null,
      patientResponsibility: null,
      posted: null,
    },
    serviceLines: [
      {
        id: "sl-enc-a-1",
        cpt: "99213",
        description: "Office visit, established patient, low complexity",
        units: 1,
        charge: 185,
        diagnosisPointers: ["1"],
      },
    ],
    diagnoses: [{ code: "J06.9", display: "Acute upper respiratory infection, unspecified" }],
    submissionReceiptId: null,
    reprocessingReceiptId: null,
    remittanceControlNumber: null,
    claimControlNumber: null,
  });
  encounterA.proposal = buildSubmitProposal(encounterA);

  const claimA = baseEpisode({
    id: "episode-claim-a",
    fixtureKey: "claim-a",
    patientName: "Blake Ortega",
    patientId: "patient-blake-ortega",
    payerName: "Northwind Health",
    payerId: "org-northwind-health",
    providerName: "Dr. Jordan Blake",
    dateOfService: "2026-07-14",
    claimId: "CLM-A-1001",
    cpt: "99214",
    billedAmount: 245,
    encounterState: "note_signed",
    chargeState: "claim_created",
    transportState: "unsent",
    adjudicationState: "not_found",
    remittanceState: "none",
    settlementState: "unknown",
    postingState: "unposted",
    resolutionState: "approval_required",
    noteState: "final",
    codingReady: true,
    coverageActive: true,
    owner: "Alex Rivera",
    issue: "Draft claim ready to submit",
    agentAction: "Submit claim",
    nextFollowUpAt: null,
    lastPayerCheckAt: null,
    lastVerifiedAt: now,
    revision: 1,
    observations: [
      obs(
        "episode-claim-a",
        "pms",
        "Draft claim",
        "ready_to_submit",
        "2026-07-14T18:00:00.000Z",
        "Claim/claim-a-1001",
        1,
      ),
    ],
    evidence: [
      {
        id: "ev-claim-a",
        title: "Draft claim",
        kind: "note",
        reference: "Claim/claim-a-1001",
        summary: "Draft professional claim awaiting submission",
        synthetic: true,
        observedAt: "2026-07-14T18:00:00.000Z",
      },
    ],
    financial: {
      billed: 245,
      allowed: null,
      paid: null,
      adjustment: null,
      patientResponsibility: null,
      posted: null,
    },
    serviceLines: [
      {
        id: "sl-claim-a-1",
        cpt: "99214",
        description: "Office visit, established patient, moderate complexity",
        units: 1,
        charge: 245,
        diagnosisPointers: ["1"],
      },
    ],
    diagnoses: [{ code: "M54.5", display: "Low back pain" }],
    proposal: null,
    submissionReceiptId: null,
    reprocessingReceiptId: null,
    remittanceControlNumber: null,
    claimControlNumber: null,
  });

  const claimB = baseEpisode({
    id: "episode-claim-b",
    fixtureKey: "claim-b",
    patientName: "Casey Nguyen",
    patientId: "patient-casey-nguyen",
    payerName: "Summit Mutual",
    payerId: "org-summit-mutual",
    providerName: "Dr. Sam Patel",
    dateOfService: "2026-06-20",
    claimId: "CLM-B-2002",
    cpt: "99213",
    billedAmount: 175,
    encounterState: "note_signed",
    chargeState: "claim_created",
    transportState: "payer_delivered",
    adjudicationState: "accepted_for_processing",
    remittanceState: "expected",
    settlementState: "unknown",
    postingState: "unposted",
    // Claim B is read-only w.r.t. proposals/approvals: the payer status
    // refresh is a dedicated non-approval read-check, so this episode never
    // enters approval_required and never carries a seed proposal.
    resolutionState: "waiting_on_payer",
    noteState: "final",
    codingReady: true,
    coverageActive: true,
    owner: "Morgan Lee",
    issue: "Accepted; remittance overdue",
    agentAction: "Refresh payer status",
    nextFollowUpAt: "2026-07-05T00:00:00.000Z",
    lastPayerCheckAt: "2026-06-28T12:00:00.000Z",
    lastVerifiedAt: "2026-06-28T12:00:00.000Z",
    revision: 1,
    observations: [
      obs(
        "episode-claim-b",
        "pms",
        "Submitted",
        "accepted_for_processing",
        "2026-06-21T10:00:00.000Z",
        "Claim/claim-b-2002",
        1,
      ),
      obs(
        "episode-claim-b",
        "clearinghouse",
        "Accepted for processing",
        "accepted_for_processing",
        "2026-06-21T14:00:00.000Z",
        "DocumentReference/doc-277-claim-b",
        2,
      ),
      obs(
        "episode-claim-b",
        "payer",
        "Accepted / in process",
        "accepted_for_processing",
        "2026-06-22T09:00:00.000Z",
        "DocumentReference/doc-portal-claim-b",
        3,
      ),
    ],
    evidence: [
      {
        id: "ev-claim-b-277",
        title: "Synthetic 277CA acceptance",
        kind: "raw_277",
        reference: "DocumentReference/doc-277-claim-b",
        summary: "Payer accepted claim for processing; no ERA yet",
        synthetic: true,
        observedAt: "2026-06-21T14:00:00.000Z",
      },
    ],
    financial: {
      billed: 175,
      allowed: null,
      paid: null,
      adjustment: null,
      patientResponsibility: null,
      posted: null,
    },
    serviceLines: [
      {
        id: "sl-claim-b-1",
        cpt: "99213",
        description: "Office visit, established patient, low complexity",
        units: 1,
        charge: 175,
        diagnosisPointers: ["1"],
      },
    ],
    diagnoses: [{ code: "R51.9", display: "Headache, unspecified" }],
    proposal: null,
    submissionReceiptId: "receipt-submit-claim-b",
    reprocessingReceiptId: null,
    remittanceControlNumber: null,
    claimControlNumber: "CN-B-2002",
  });

  const claimCId = "episode-claim-c";
  const claimC = baseEpisode({
    id: claimCId,
    fixtureKey: "claim-c",
    patientName: "Dana Okonkwo",
    patientId: "patient-dana-okonkwo",
    payerName: "Summit Mutual",
    payerId: "org-summit-mutual",
    providerName: "Dr. Jordan Blake",
    dateOfService: "2026-06-12",
    claimId: "CLM-C-3003",
    cpt: "97110",
    billedAmount: 420,
    encounterState: "note_signed",
    chargeState: "claim_created",
    transportState: "payer_delivered",
    adjudicationState: "denied",
    remittanceState: "none",
    settlementState: "unknown",
    postingState: "unposted",
    resolutionState: "approval_required",
    noteState: "final",
    codingReady: true,
    coverageActive: true,
    owner: "Alex Rivera",
    issue: "PMS processing vs payer authorization denial",
    agentAction: "Request reprocessing",
    nextFollowUpAt: null,
    lastPayerCheckAt: "2026-07-10T16:00:00.000Z",
    lastVerifiedAt: "2026-07-10T16:00:00.000Z",
    revision: 1,
    observations: [
      obs(
        claimCId,
        "pms",
        "Processing",
        "processing",
        "2026-07-01T12:00:00.000Z",
        "Claim/claim-c-3003",
        1,
      ),
      obs(
        claimCId,
        "clearinghouse",
        "Payer accepted",
        "accepted_for_processing",
        "2026-06-20T11:00:00.000Z",
        "DocumentReference/doc-277-claim-c",
        2,
      ),
      obs(
        claimCId,
        "payer",
        "Denied: authorization required",
        "denied",
        "2026-07-10T16:00:00.000Z",
        "DocumentReference/doc-portal-claim-c",
        3,
      ),
    ],
    evidence: [
      {
        id: "ev-claim-c-auth",
        title: "Authorization not required",
        kind: "authorization",
        reference: "DocumentReference/doc-auth-claim-c",
        summary:
          "Authorization-not-required decision covering DOS 2026-06-12 for CPT 97110",
        synthetic: true,
        observedAt: "2026-06-01T09:00:00.000Z",
      },
      {
        id: "ev-claim-c-portal",
        title: "Payer portal denial snapshot",
        kind: "portal_snapshot",
        reference: "DocumentReference/doc-portal-claim-c",
        summary: "Denied: authorization required",
        synthetic: true,
        observedAt: "2026-07-10T16:00:00.000Z",
      },
      {
        id: "ev-claim-c-277",
        title: "Synthetic 277 acceptance",
        kind: "raw_277",
        reference: "DocumentReference/doc-277-claim-c",
        summary: "Clearinghouse reported payer accepted for processing",
        synthetic: true,
        observedAt: "2026-06-20T11:00:00.000Z",
      },
    ],
    financial: {
      billed: 420,
      allowed: null,
      paid: null,
      adjustment: null,
      patientResponsibility: null,
      posted: null,
    },
    serviceLines: [
      {
        id: "sl-claim-c-1",
        cpt: "97110",
        description: "Therapeutic exercises, 15 minutes",
        units: 4,
        charge: 420,
        diagnosisPointers: ["1"],
      },
    ],
    diagnoses: [{ code: "M25.511", display: "Pain in right shoulder" }],
    proposal: null,
    submissionReceiptId: "receipt-submit-claim-c",
    reprocessingReceiptId: null,
    remittanceControlNumber: null,
    claimControlNumber: "CN-C-3003",
  });
  claimC.proposal = buildReprocessingProposal(claimC);

  const claimD = baseEpisode({
    id: "episode-claim-d",
    fixtureKey: "claim-d",
    patientName: "Ellis Park",
    patientId: "patient-ellis-park",
    payerName: "Northwind Health",
    payerId: "org-northwind-health",
    providerName: "Dr. Sam Patel",
    dateOfService: "2026-07-08",
    claimId: "CLM-D-4004",
    cpt: "99213",
    billedAmount: 165,
    encounterState: "note_signed",
    chargeState: "claim_created",
    transportState: "clearinghouse_rejected",
    adjudicationState: "not_found",
    remittanceState: "none",
    settlementState: "unknown",
    postingState: "unposted",
    resolutionState: "approval_required",
    noteState: "final",
    codingReady: true,
    coverageActive: true,
    owner: "Morgan Lee",
    issue: "Member ID mismatch rejection",
    agentAction: "Correct member ID",
    nextFollowUpAt: addDays(now, 1),
    lastPayerCheckAt: "2026-07-09T08:00:00.000Z",
    lastVerifiedAt: "2026-07-09T08:00:00.000Z",
    revision: 1,
    observations: [
      obs(
        "episode-claim-d",
        "pms",
        "Submitted",
        "sent",
        "2026-07-08T17:00:00.000Z",
        "Claim/claim-d-4004",
        1,
      ),
      obs(
        "episode-claim-d",
        "clearinghouse",
        "Rejected: member mismatch",
        "clearinghouse_rejected",
        "2026-07-09T08:00:00.000Z",
        "DocumentReference/doc-277-claim-d",
        2,
      ),
    ],
    evidence: [
      {
        id: "ev-claim-d-277",
        title: "Synthetic 277 rejection",
        kind: "raw_277",
        reference: "DocumentReference/doc-277-claim-d",
        summary: "Clearinghouse rejected before adjudication: member mismatch",
        synthetic: true,
        observedAt: "2026-07-09T08:00:00.000Z",
      },
    ],
    financial: {
      billed: 165,
      allowed: null,
      paid: null,
      adjustment: null,
      patientResponsibility: null,
      posted: null,
    },
    serviceLines: [
      {
        id: "sl-claim-d-1",
        cpt: "99213",
        description: "Office visit, established patient, low complexity",
        units: 1,
        charge: 165,
        diagnosisPointers: ["1"],
      },
    ],
    diagnoses: [{ code: "J02.9", display: "Acute pharyngitis, unspecified" }],
    proposal: null,
    submissionReceiptId: "receipt-submit-claim-d",
    reprocessingReceiptId: null,
    remittanceControlNumber: null,
    claimControlNumber: "CN-D-4004",
    // Stale member id on file -- the actual cause of the clearinghouse
    // rejection. correct_and_resubmit corrects it (see deriveCorrectedMemberId).
    memberId: "MEM-OLD-4004",
  });

  const claimE = baseEpisode({
    id: "episode-claim-e",
    fixtureKey: "claim-e",
    patientName: "Finley Shaw",
    patientId: "patient-finley-shaw",
    payerName: "Summit Mutual",
    payerId: "org-summit-mutual",
    providerName: "Dr. Jordan Blake",
    dateOfService: "2026-07-02",
    claimId: "CLM-E-5005",
    cpt: "99215",
    billedAmount: 310,
    encounterState: "note_signed",
    chargeState: "claim_created",
    transportState: "payer_delivered",
    adjudicationState: "info_requested",
    remittanceState: "none",
    settlementState: "unknown",
    postingState: "unposted",
    resolutionState: "approval_required",
    noteState: "final",
    codingReady: true,
    coverageActive: true,
    owner: "Alex Rivera",
    issue: "Pended: supporting note missing",
    agentAction: "Send requested documentation",
    nextFollowUpAt: addDays(now, 2),
    lastPayerCheckAt: "2026-07-11T10:00:00.000Z",
    lastVerifiedAt: "2026-07-11T10:00:00.000Z",
    revision: 1,
    observations: [
      obs(
        "episode-claim-e",
        "pms",
        "Processing",
        "pending",
        "2026-07-03T09:00:00.000Z",
        "Claim/claim-e-5005",
        1,
      ),
      obs(
        "episode-claim-e",
        "clearinghouse",
        "Delivered to payer",
        "payer_delivered",
        "2026-07-03T12:00:00.000Z",
        "DocumentReference/doc-277-claim-e",
        2,
      ),
      obs(
        "episode-claim-e",
        "payer",
        "Pended: supporting documentation requested",
        "info_requested",
        "2026-07-11T10:00:00.000Z",
        "DocumentReference/doc-portal-claim-e",
        3,
      ),
    ],
    evidence: [
      {
        id: "ev-claim-e-portal",
        title: "Payer pend notice",
        kind: "portal_snapshot",
        reference: "DocumentReference/doc-portal-claim-e",
        summary: "Supporting progress note requested",
        synthetic: true,
        observedAt: "2026-07-11T10:00:00.000Z",
      },
      {
        id: "ev-claim-e-signed-note",
        title: "Signed supporting progress note",
        kind: "note",
        reference: "DocumentReference/doc-note-claim-e",
        summary: "Signed progress note ready to send for payer documentation request",
        synthetic: true,
        observedAt: "2026-07-10T16:00:00.000Z",
      },
    ],
    financial: {
      billed: 310,
      allowed: null,
      paid: null,
      adjustment: null,
      patientResponsibility: null,
      posted: null,
    },
    serviceLines: [
      {
        id: "sl-claim-e-1",
        cpt: "99215",
        description: "Office visit, established patient, high complexity",
        units: 1,
        charge: 310,
        diagnosisPointers: ["1"],
      },
    ],
    diagnoses: [{ code: "I10", display: "Essential (primary) hypertension" }],
    proposal: null,
    submissionReceiptId: "receipt-submit-claim-e",
    reprocessingReceiptId: null,
    remittanceControlNumber: null,
    claimControlNumber: "CN-E-5005",
  });

  const claimF = baseEpisode({
    id: "episode-claim-f",
    fixtureKey: "claim-f",
    patientName: "Greta Mills",
    patientId: "patient-greta-mills",
    payerName: "Northwind Health",
    payerId: "org-northwind-health",
    providerName: "Dr. Sam Patel",
    dateOfService: "2026-07-01",
    claimId: "CLM-F-6006",
    cpt: "99213",
    billedAmount: 190,
    encounterState: "note_signed",
    chargeState: "claim_created",
    transportState: "payer_delivered",
    adjudicationState: "paid",
    remittanceState: "received",
    settlementState: "received",
    postingState: "reconciled",
    resolutionState: "closed",
    noteState: "final",
    codingReady: true,
    coverageActive: true,
    owner: "Morgan Lee",
    issue: null,
    agentAction: null,
    nextFollowUpAt: null,
    lastPayerCheckAt: "2026-07-12T15:00:00.000Z",
    lastVerifiedAt: "2026-07-12T15:00:00.000Z",
    revision: 1,
    observations: [
      obs(
        "episode-claim-f",
        "pms",
        "Paid / posted",
        "paid",
        "2026-07-12T15:00:00.000Z",
        "Claim/claim-f-6006",
        1,
      ),
      obs(
        "episode-claim-f",
        "clearinghouse",
        "Delivered",
        "payer_delivered",
        "2026-07-02T10:00:00.000Z",
        "DocumentReference/doc-277-claim-f",
        2,
      ),
      obs(
        "episode-claim-f",
        "payer",
        "Paid",
        "paid",
        "2026-07-10T11:00:00.000Z",
        "DocumentReference/doc-portal-claim-f",
        3,
      ),
      obs(
        "episode-claim-f",
        "remittance",
        "ERA received",
        "received",
        "2026-07-11T09:00:00.000Z",
        "DocumentReference/doc-835-claim-f",
        4,
      ),
      obs(
        "episode-claim-f",
        "posting",
        "Posted and reconciled",
        "reconciled",
        "2026-07-12T15:00:00.000Z",
        "DocumentReference/doc-posting-claim-f",
        5,
      ),
    ],
    evidence: [
      {
        id: "ev-claim-f-835",
        title: "Synthetic 835 ERA",
        kind: "raw_835",
        reference: "DocumentReference/doc-835-claim-f",
        summary: "ERA paid $152.00 for control number CN-F-6006",
        synthetic: true,
        observedAt: "2026-07-11T09:00:00.000Z",
      },
      {
        id: "ev-claim-f-era-pdf",
        title: "ERA PDF",
        kind: "era_pdf",
        reference: "DocumentReference/doc-835-pdf-claim-f",
        summary: "Best-effort ERA PDF copy",
        synthetic: true,
        observedAt: "2026-07-11T09:05:00.000Z",
      },
      {
        id: "ev-claim-f-posting",
        title: "PMS posting receipt",
        kind: "pms_posting",
        reference: "DocumentReference/doc-posting-claim-f",
        summary: "PMS posted $152.00 against control number CN-F-6006, independent of the ERA",
        synthetic: true,
        observedAt: "2026-07-12T15:00:00.000Z",
      },
    ],
    financial: {
      billed: 190,
      allowed: 160,
      paid: 152,
      adjustment: 30,
      patientResponsibility: 8,
      posted: 152,
    },
    serviceLines: [
      {
        id: "sl-claim-f-1",
        cpt: "99213",
        description: "Office visit, established patient, low complexity",
        units: 1,
        charge: 190,
        diagnosisPointers: ["1"],
      },
    ],
    diagnoses: [{ code: "Z00.00", display: "Encounter for general adult medical examination without abnormal findings" }],
    proposal: null,
    submissionReceiptId: "receipt-submit-claim-f",
    reprocessingReceiptId: null,
    remittanceControlNumber: "CN-F-6006",
    claimControlNumber: "CN-F-6006",
  });

  return [encounterA, claimA, claimB, claimC, claimD, claimE, claimF];
}

export function buildFhirBundle(episodes = createSeedEpisodes()): Bundle {
  const resources: Resource[] = [];
  const now = getDemoClock();
  const payerIds = new Set<string>();

  resources.push({
    resourceType: "Organization",
    id: PRACTICE_ID,
    name: "Harborview Demo Practice",
  });

  for (const episode of episodes) {
    resources.push({
      resourceType: "Patient",
      id: episode.patientId.replace("patient-", ""),
      name: [{ text: episode.patientName }],
      gender: "unknown",
    });

    const payerResourceId = episode.payerId.replace("org-", "");
    if (!payerIds.has(payerResourceId)) {
      payerIds.add(payerResourceId);
      resources.push({
        resourceType: "Organization",
        id: payerResourceId,
        name: episode.payerName,
        type: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/organization-type",
                code: "ins",
                display: "Insurance Company",
              },
            ],
          },
        ],
      });
    }

    resources.push({
      resourceType: "Coverage",
      id: `coverage-${episode.id}`,
      status: "active",
      beneficiary: { reference: `Patient/${episode.patientId.replace("patient-", "")}` },
      payor: [{ reference: `Organization/${episode.payerId.replace("org-", "")}` }],
      subscriberId: `SYN-${episode.id.toUpperCase()}`,
    });

    resources.push({
      resourceType: "Encounter",
      id: `encounter-${episode.id}`,
      status:
        episode.encounterState === "note_signed" || episode.encounterState === "completed"
          ? "finished"
          : "in-progress",
      class: {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: "AMB",
        display: "ambulatory",
      },
      subject: { reference: `Patient/${episode.patientId.replace("patient-", "")}` },
      period: {
        start: `${episode.dateOfService}T14:00:00.000Z`,
        end: `${episode.dateOfService}T14:30:00.000Z`,
      },
    });

    for (const dx of episode.diagnoses) {
      resources.push({
        resourceType: "Condition",
        id: `condition-${episode.id}-${dx.code.replace(".", "")}`,
        subject: { reference: `Patient/${episode.patientId.replace("patient-", "")}` },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10-cm",
              code: dx.code,
              display: dx.display,
            },
          ],
          text: dx.display,
        },
        clinicalStatus: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
              code: "active",
            },
          ],
        },
      });
    }

    for (const line of episode.serviceLines) {
      resources.push({
        resourceType: "ChargeItem",
        id: line.id,
        status: "billable",
        code: {
          coding: [
            {
              system: "http://www.ama-assn.org/go/cpt",
              code: line.cpt,
              display: line.description,
            },
          ],
        },
        subject: { reference: `Patient/${episode.patientId.replace("patient-", "")}` },
        context: { reference: `Encounter/encounter-${episode.id}` },
        quantity: { value: line.units },
        priceOverride: { value: line.charge, currency: "USD" },
      });
    }

    if (episode.claimId) {
      const claimResource = buildClaimResource(episode);
      if (claimResource) resources.push(claimResource);

      if (episode.submissionReceiptId) {
        resources.push({
          resourceType: "ClaimResponse",
          id: episode.submissionReceiptId.toLowerCase(),
          identifier: [
            {
              system: "https://www.stedi.com/claims",
              value: `SYNTHETIC-${episode.claimControlNumber ?? episode.claimId}`,
            },
          ],
          status: "active",
          type: {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/claim-type",
                code: "professional",
              },
            ],
          },
          use: "claim",
          patient: {
            reference: `Patient/${episode.patientId.replace("patient-", "")}`,
          },
          created: episode.lastVerifiedAt,
          insurer: { reference: `Organization/${payerResourceId}` },
          requestor: { display: episode.providerName },
          request: { reference: `Claim/${episode.claimId.toLowerCase()}` },
          outcome: "complete",
          disposition:
            "Synthetic submission receipt only; this is not payer adjudication or payment.",
          total: [
            {
              category: { text: "submitted-charge" },
              amount: { value: episode.billedAmount, currency: "USD" },
            },
          ],
        });
      }
    }

    for (const evidence of episode.evidence) {
      if (
        evidence.kind === "raw_277" ||
        evidence.kind === "raw_835" ||
        evidence.kind === "portal_snapshot" ||
        evidence.kind === "authorization" ||
        evidence.kind === "era_pdf" ||
        evidence.kind === "artifact" ||
        evidence.kind === "note" ||
        evidence.kind === "pms_posting"
      ) {
        const id = evidence.reference.includes("/")
          ? evidence.reference.split("/").at(-1)!
          : evidence.id;
        resources.push({
          resourceType: "DocumentReference",
          id,
          status: "current",
          docStatus: evidence.kind === "note" ? "final" : undefined,
          type: {
            text: evidence.title,
          },
          subject: {
            reference: `Patient/${episode.patientId.replace("patient-", "")}`,
          },
          description: `${evidence.summary} [synthetic]`,
          date: evidence.observedAt,
          context: {
            encounter: [{ reference: `Encounter/encounter-${episode.id}` }],
            related: episode.claimId
              ? [{ reference: `Claim/${episode.claimId.toLowerCase()}` }]
              : undefined,
          },
          content: [
            {
              attachment: {
                contentType: "application/json",
                title: evidence.title,
                data: Buffer.from(
                  JSON.stringify({
                    synthetic: true,
                    summary: evidence.summary,
                    episodeId: episode.id,
                  }),
                ).toString("base64"),
              },
            },
          ],
        });
      }
    }

    if (episode.fixtureKey === "claim-f") {
      // PaymentReconciliation supports remittance linkage only; it is never
      // accepted as PMS posting evidence (see src/domain/verified-paid.ts).
      resources.push({
        resourceType: "PaymentReconciliation",
        id: "payrec-claim-f",
        status: "active",
        created: "2026-07-12T15:00:00.000Z",
        paymentDate: "2026-07-11",
        paymentAmount: { value: 152, currency: "USD" },
        paymentIdentifier: episode.claimControlNumber
          ? { value: episode.claimControlNumber }
          : undefined,
        detail: [
          {
            type: {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/payment-type",
                  code: "payment",
                },
              ],
            },
            request: { reference: `Claim/${episode.claimId!.toLowerCase()}` },
            response: episode.submissionReceiptId
              ? { reference: `ClaimResponse/${episode.submissionReceiptId.toLowerCase()}` }
              : undefined,
            amount: { value: 152, currency: "USD" },
          },
        ],
      });
    }

    resources.push({
      resourceType: "Task",
      id: `task-${episode.id}`,
      status:
        episode.resolutionState === "closed"
          ? "completed"
          : episode.resolutionState === "approval_required"
            ? "requested"
            : "in-progress",
      intent: "order",
      code: { text: "claim-episode" },
      businessStatus: { text: episode.resolutionState },
      description: `Claim episode projection for ${episode.patientName}`,
      focus: {
        reference: episode.claimId
          ? `Claim/${episode.claimId.toLowerCase()}`
          : `Encounter/encounter-${episode.id}`,
      },
      for: { reference: `Patient/${episode.patientId.replace("patient-", "")}` },
      encounter: { reference: `Encounter/encounter-${episode.id}` },
      authoredOn: episode.lastVerifiedAt,
      lastModified: episode.lastVerifiedAt,
      owner: { display: episode.owner },
      reasonCode: episode.issue ? { text: episode.issue } : undefined,
    });

    for (const resource of episode.fhirResources ?? []) {
      if (
        resource &&
        typeof resource === "object" &&
        "resourceType" in resource &&
        "id" in resource
      ) {
        resources.push(resource as unknown as Resource);
      }
    }
  }

  return {
    resourceType: "Bundle",
    id: "bundle-synthetic-demo",
    type: "collection",
    timestamp: now,
    entry: resources.map((resource) => ({
      fullUrl: `${resource.resourceType}/${resource.id}`,
      resource,
    })),
  };
}

export const SEED_SESSION_LABEL = "synthetic-demo-v1";
