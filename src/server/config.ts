import { z } from "zod";
import type { AgentMode, HealthcareMode } from "@/domain/types";

const configSchema = z.object({
  healthcareMode: z.enum(["local", "medplum"]),
  agentMode: z.enum(["synthetic", "bff"]),
  stediMode: z.enum(["off", "test"]),
  stediBaseUrl: z.string().url().optional(),
  stediApiKey: z.string().min(1).optional(),
  mossMode: z.enum(["off", "live"]),
  mossExecution: z.enum(["cloud", "local"]),
  mossProjectId: z.string().min(1).optional(),
  mossProjectKey: z.string().min(1).optional(),
  mossIndexName: z.string().min(1).optional(),
  medplumBaseUrl: z.string().url().optional(),
  medplumClientId: z.string().min(1).optional(),
  medplumClientSecret: z.string().min(1).optional(),
  medplumProjectId: z.string().min(1).optional(),
  bffBaseUrl: z.string().url().optional(),
  bffApiKey: z.string().min(1).optional(),
});

export type ServerConfig = z.infer<typeof configSchema> & {
  healthcareMode: HealthcareMode;
  agentMode: AgentMode;
};

/**
 * Server-only configuration. Never import this module from client components.
 * Credentials must never use NEXT_PUBLIC_ prefixes.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const healthcareMode = (env.HEALTHCARE_MODE as HealthcareMode) || "local";
  const agentMode = (env.AGENT_MODE as AgentMode) || "synthetic";
  const stediMode = env.STEDI_MODE === "test" ? "test" : "off";
  const mossMode = env.MOSS_MODE === "live" ? "live" : "off";
  const mossExecution = env.MOSS_EXECUTION === "local" ? "local" : "cloud";

  const parsed = configSchema.safeParse({
    healthcareMode,
    agentMode,
    stediMode,
    stediBaseUrl: env.STEDI_BASE_URL,
    stediApiKey: env.STEDI_API_KEY,
    mossMode,
    mossExecution,
    mossProjectId: env.MOSS_PROJECT_ID,
    mossProjectKey: env.MOSS_PROJECT_KEY,
    mossIndexName: env.MOSS_INDEX_NAME,
    medplumBaseUrl: env.MEDPLUM_BASE_URL,
    medplumClientId: env.MEDPLUM_CLIENT_ID,
    medplumClientSecret: env.MEDPLUM_CLIENT_SECRET,
    medplumProjectId: env.MEDPLUM_PROJECT_ID,
    bffBaseUrl: env.BFF_BASE_URL,
    bffApiKey: env.BFF_API_KEY,
  });

  if (!parsed.success) {
    throw new Error(`Invalid server config: ${parsed.error.message}`);
  }

  const config = parsed.data;

  if (config.healthcareMode === "medplum") {
    if (
      !config.medplumBaseUrl ||
      !config.medplumClientId ||
      !config.medplumClientSecret ||
      !config.medplumProjectId
    ) {
      throw new Error(
        "HEALTHCARE_MODE=medplum requires MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET, MEDPLUM_PROJECT_ID",
      );
    }
  }

  if (config.agentMode === "bff") {
    if (!config.bffBaseUrl || !config.bffApiKey) {
      throw new Error("AGENT_MODE=bff requires BFF_BASE_URL and BFF_API_KEY");
    }
  }

  if (config.stediMode === "test" && !config.stediApiKey) {
    throw new Error("STEDI_MODE=test requires STEDI_API_KEY");
  }

  if (
    config.mossMode === "live" &&
    (!config.mossProjectId || !config.mossProjectKey || !config.mossIndexName)
  ) {
    throw new Error(
      "MOSS_MODE=live requires MOSS_PROJECT_ID, MOSS_PROJECT_KEY, and MOSS_INDEX_NAME",
    );
  }

  return config;
}

export function publicAdapterStatus(config: ServerConfig): {
  healthcareMode: HealthcareMode;
  agentMode: AgentMode;
  medplumConfigured: boolean;
  bffConfigured: boolean;
  stediMode: "off" | "test";
  stediConfigured: boolean;
  mossMode: "off" | "live";
  mossConfigured: boolean;
  mossExecution: "cloud" | "local";
} {
  return {
    healthcareMode: config.healthcareMode,
    agentMode: config.agentMode,
    medplumConfigured: Boolean(
      config.medplumBaseUrl &&
        config.medplumClientId &&
        config.medplumClientSecret &&
        config.medplumProjectId,
    ),
    bffConfigured: Boolean(config.bffBaseUrl && config.bffApiKey),
    stediMode: config.stediMode,
    stediConfigured: config.stediMode === "test" && Boolean(config.stediApiKey),
    mossMode: config.mossMode,
    mossConfigured:
      config.mossMode === "live" &&
      Boolean(config.mossProjectId && config.mossProjectKey && config.mossIndexName),
    mossExecution: config.mossExecution,
  };
}
