import type { DemoSnapshot } from "@/domain/types";

export interface HealthcareRepository {
  mode: "local" | "medplum";
  readSnapshot(): Promise<DemoSnapshot>;
  /** Connected writes are never performed without explicit credentials and approval. */
  describeLimitations(): string[];
}

export function createLocalHealthcareRepository(
  read: () => DemoSnapshot,
): HealthcareRepository {
  return {
    mode: "local",
    async readSnapshot() {
      return read();
    },
    describeLimitations() {
      return [
        "Local synthetic FHIR fixtures only",
        "No connected Medplum project",
        "Raw 277/835 are synthetic DocumentReference evidence",
      ];
    },
  };
}
