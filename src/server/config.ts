import { z } from "zod";
import type { AgentMode, HealthcareMode } from "@/domain/types";

const configSchema = z.object({
  healthcareMode: z.enum(["local", "medplum"]),
  agentMode: z.enum(["synthetic", "bff"]),
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

  const parsed = configSchema.safeParse({
    healthcareMode,
    agentMode,
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

  return config;
}

export function publicAdapterStatus(config: ServerConfig): {
  healthcareMode: HealthcareMode;
  agentMode: AgentMode;
  medplumConfigured: boolean;
  bffConfigured: boolean;
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
  };
}
