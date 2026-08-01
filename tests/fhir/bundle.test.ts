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

  it("claim D correct_and_resubmit preserves both Claim resources with a related:prior link and a member id diff (P1)", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-fhir-claim-d-"));
    const store = new LocalEventStore({
      dataDir,
      healthcareMode: "local",
      agentMode: "synthetic",
    });
    const actions = new ActionService(store);

    const before = store.getEpisode("episode-claim-d")!;
    expect(before.memberId).toBe("MEM-OLD-4004");
    const originalClaimId = before.claimId!;

    const result = await actions.decide({
      episodeId: "episode-claim-d",
      actionType: "correct_and_resubmit",
      decision: "allow_once",
      scope: proposalApprovalFields(before.proposal!),
    });
    expect("correctedClaimId" in result && result.correctedClaimId).toBeTruthy();

    const after = store.getEpisode("episode-claim-d")!;
    expect(after.correctedFromClaimId).toBe(originalClaimId);
    expect(after.claimId).not.toBe(originalClaimId);
    expect(after.memberId).toBe("MEM-NEW-4004");

    const episodes = store.getSnapshot().episodes;
    const bundle = buildFhirBundle(episodes);
    expect(validateBundle(bundle)).toEqual([]);

    const claims = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter(
        (r): r is Resource & { id: string; related?: unknown[] } =>
          r?.resourceType === "Claim",
      );
    const originalClaim = claims.find(
      (c) => c.id === originalClaimId.toLowerCase(),
    );
    const correctedClaim = claims.find((c) => c.id === after.claimId!.toLowerCase());
    expect(originalClaim, "original claim must still be present in the bundle").toBeTruthy();
    expect(correctedClaim, "corrected claim must be present in the bundle").toBeTruthy();
    expect(originalClaim).not.toBe(correctedClaim);

    const related = (
      correctedClaim as unknown as {
        related?: Array<{
          claim?: { reference?: string };
          relationship?: { coding?: Array<{ system?: string; code?: string }> };
        }>;
      }
    ).related;
    expect(related?.[0]?.claim?.reference).toBe(`Claim/${originalClaimId.toLowerCase()}`);
    expect(related?.[0]?.relationship?.coding?.[0]).toMatchObject({
      system: "http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship",
      code: "prior",
    });

    const diffEvidence = after.evidence.find((e) => e.kind === "artifact" && e.title === "Correction diff");
    expect(diffEvidence?.summary).toContain("MEM-OLD-4004 -> MEM-NEW-4004");
    expect(after.activities.some((a) => a.summary.includes("MEM-OLD-4004 -> MEM-NEW-4004"))).toBe(
      true,
    );
  });
});
