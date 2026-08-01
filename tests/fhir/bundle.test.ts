import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  indexStructureDefinitionBundle,
  tryGetDataType,
  validateResource,
} from "@medplum/core";
import { readJson } from "@medplum/definitions";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import { buildFhirBundle, createSeedEpisodes } from "@/domain/fixtures";
import { LocalEventStore } from "@/server/store";
import { ActionService } from "@/server/actions";
import { proposalApprovalFields } from "@/domain/approval";

const NEEDED_TYPES = new Set([
  "Patient",
  "Organization",
  "Coverage",
  "Encounter",
  "Condition",
  "ChargeItem",
  "Claim",
  "ClaimResponse",
  "DocumentReference",
  "PaymentReconciliation",
  "Task",
  "Bundle",
  "Provenance",
  "AuditEvent",
]);

beforeAll(() => {
  for (const file of [
    "fhir/r4/profiles-types.json",
    "fhir/r4/profiles-resources.json",
  ]) {
    const bundle = readJson(file) as Bundle;
    const filtered: Bundle = {
      ...bundle,
      entry: (bundle.entry ?? []).filter((entry) => {
        const resource = entry.resource as Resource | undefined;
        if (!resource || resource.resourceType !== "StructureDefinition") {
          return false;
        }
        const typeName = (resource as { type?: string; name?: string }).type;
        return typeName ? NEEDED_TYPES.has(typeName) || typeName.length < 3 : false;
      }),
    };
    // Keep complex types used by our resources by indexing full types bundle.
    if (file.includes("profiles-types")) {
      indexStructureDefinitionBundle(bundle);
    } else {
      indexStructureDefinitionBundle(filtered);
    }
  }
});

function validateBundle(bundle: Bundle): string[] {
  const issues: string[] = [];
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    if (!resource) continue;
    try {
      const result = validateResource(resource);
      for (const issue of result) {
        if (issue.severity === "error") {
          issues.push(
            `${resource.resourceType}/${resource.id}: ${issue.details?.text ?? issue.code}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`${resource.resourceType}/${resource.id}: ${message}`);
    }
  }
  return issues;
}

describe("FHIR fixture validation (A19)", () => {
  it("indexes needed resource schemas and validates synthetic fixtures", () => {
    for (const typeName of NEEDED_TYPES) {
      if (typeName === "Bundle") continue;
      expect(tryGetDataType(typeName), typeName).toBeTruthy();
    }

    const bundle = buildFhirBundle(createSeedEpisodes());
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.entry?.length).toBeGreaterThan(10);

    expect(validateBundle(bundle)).toEqual([]);
    expect(
      bundle.entry?.some(
        (e) =>
          e.resource?.resourceType === "DocumentReference" &&
          String(
            (e.resource as { description?: string }).description ?? "",
          ).includes("synthetic"),
      ),
    ).toBe(true);
  });

  it("submission and reprocessing materialize valid Provenance and AuditEvent links", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-fhir-"));
    const store = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    const actions = new ActionService(store);

    await actions.decide({
      episodeId: "episode-encounter-a",
      actionType: "submit_claim",
      decision: "allow_once",
      scope: proposalApprovalFields(
        store.getEpisode("episode-encounter-a")!.proposal!,
      ),
    });
    await actions.decide({
      episodeId: "episode-claim-c",
      actionType: "request_reprocessing",
      decision: "allow_once",
      scope: proposalApprovalFields(
        store.getEpisode("episode-claim-c")!.proposal!,
      ),
    });

    const episodes = store.getSnapshot().episodes;
    const bundle = buildFhirBundle(episodes);
    expect(validateBundle(bundle)).toEqual([]);

    const submitted = store.getEpisode("episode-encounter-a")!;
    const reprocessed = store.getEpisode("episode-claim-c")!;

    const submitAudit = submitted.fhirResources.find(
      (r) => r.resourceType === "AuditEvent",
    ) as { entity?: Array<{ what?: { reference?: string } }> };
    expect(submitAudit).toBeTruthy();
    expect(
      submitAudit.entity?.some(
        (e) =>
          e.what?.reference === `Claim/${submitted.claimId}` ||
          e.what?.reference?.includes("Claim/"),
      ),
    ).toBe(true);

    const provenance = reprocessed.fhirResources.find(
      (r) => r.resourceType === "Provenance",
    ) as { target?: Array<{ reference?: string }> };
    const reprocessAudit = reprocessed.fhirResources.find(
      (r) => r.resourceType === "AuditEvent",
    ) as { entity?: Array<{ what?: { reference?: string } }> };
    expect(provenance).toBeTruthy();
    expect(reprocessAudit).toBeTruthy();
    expect(
      provenance.target?.some((t) => t.reference?.includes("Claim/")),
    ).toBe(true);
    expect(
      reprocessAudit.entity?.some((e) =>
        e.what?.reference?.includes("DocumentReference/"),
      ),
    ).toBe(true);

    expect(
      bundle.entry?.some((e) => e.resource?.resourceType === "Provenance"),
    ).toBe(true);
    expect(
      bundle.entry?.some((e) => e.resource?.resourceType === "AuditEvent"),
    ).toBe(true);
  });
});
