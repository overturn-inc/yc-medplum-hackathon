import type { AuditEvent, Provenance, Resource } from "@medplum/fhirtypes";
import { getDemoClock } from "./clock";

export function buildSubmissionAuditEvent(input: {
  episodeId: string;
  claimId: string;
  receiptId: string;
  at?: string;
}): AuditEvent {
  const at = input.at ?? getDemoClock();
  return {
    resourceType: "AuditEvent",
    id: `submit-${input.receiptId}`,
    type: {
      system: "http://terminology.hl7.org/CodeSystem/audit-event-type",
      code: "rest",
      display: "RESTful Operation",
    },
    action: "C",
    recorded: at,
    agent: [
      {
        who: { display: "Harborview synthetic approval executor" },
        requestor: true,
      },
    ],
    source: {
      observer: { display: "Harborview PMS demo" },
    },
    entity: [
      {
        what: { reference: `Claim/${input.claimId.toLowerCase()}` },
        type: {
          system: "http://terminology.hl7.org/CodeSystem/audit-entity-type",
          code: "2",
          display: "System Object",
        },
        role: {
          system: "http://terminology.hl7.org/CodeSystem/object-role",
          code: "4",
          display: "Domain Resource",
        },
      },
      {
        what: { reference: `ClaimResponse/${input.receiptId}` },
        description: `Submission receipt for episode ${input.episodeId}`,
      },
    ],
  };
}

export function buildReprocessingProvenance(input: {
  episodeId: string;
  claimId: string;
  artifactId: string;
  receiptId: string;
  at?: string;
}): Provenance {
  const at = input.at ?? getDemoClock();
  return {
    resourceType: "Provenance",
    id: `reprocess-${input.episodeId}`,
    target: [
      { reference: `Claim/${input.claimId.toLowerCase()}` },
      { reference: input.artifactId },
      { reference: `ClaimResponse/${input.receiptId}` },
    ],
    recorded: at,
    activity: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
          code: "UPDATE",
          display: "revise",
        },
      ],
      text: "Payer reprocessing request after authorization evidence review",
    },
    agent: [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "composer",
              display: "Composer",
            },
          ],
        },
        who: { display: "Harborview synthetic agent" },
      },
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "verifier",
              display: "Verifier",
            },
          ],
        },
        who: { display: "Human approver (Allow once)" },
      },
    ],
    entity: [
      {
        role: "source",
        what: { reference: input.artifactId },
      },
    ],
  };
}

export function buildReprocessingAuditEvent(input: {
  episodeId: string;
  claimId: string;
  artifactId: string;
  receiptId: string;
  at?: string;
}): AuditEvent {
  const at = input.at ?? getDemoClock();
  return {
    resourceType: "AuditEvent",
    id: `reprocess-${input.episodeId}`,
    type: {
      system: "http://terminology.hl7.org/CodeSystem/audit-event-type",
      code: "rest",
      display: "RESTful Operation",
    },
    action: "E",
    recorded: at,
    agent: [
      {
        who: { display: "Harborview synthetic approval executor" },
        requestor: true,
      },
    ],
    source: {
      observer: { display: "Harborview PMS demo" },
    },
    entity: [
      {
        what: { reference: `Claim/${input.claimId.toLowerCase()}` },
      },
      {
        what: { reference: input.artifactId },
        description: "Payer reprocessing message artifact",
      },
      {
        what: { reference: `ClaimResponse/${input.receiptId}` },
        description: `Execution receipt for episode ${input.episodeId}`,
      },
    ],
  };
}

export function asResourceList(resources: Resource[]): Resource[] {
  return resources;
}
