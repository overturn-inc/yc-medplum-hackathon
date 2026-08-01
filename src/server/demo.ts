import { createBffAgentAdapter, sanitizeBffError } from "@/adapters/agent/bff";
import { cache } from "react";
import { createSyntheticAgentAdapter } from "@/adapters/agent/synthetic";
import { createLocalHealthcareRepository } from "@/adapters/healthcare/local";
import {
  createMedplumHealthcareRepository,
  sanitizeMedplumError,
} from "@/adapters/healthcare/medplum";
import {
  buildQueues,
  computeDashboardKpi,
  enrichEpisode,
  projectEpisodes,
} from "@/domain/projector";
import { runPreflight } from "@/domain/preflight";
import type { ClaimEpisode, DemoSnapshot } from "@/domain/types";
import { ActionService } from "@/server/actions";
import { loadServerConfig, publicAdapterStatus } from "@/server/config";
import { StoreDegradedError } from "@/server/store";
import type { SessionRepository } from "@/server/repository";

type AgentStatus = { available: boolean; error?: string };

const probeBffForRender = cache(
  async (baseUrl: string, apiKey: string): Promise<AgentStatus> => {
    const agent = createBffAgentAdapter({ baseUrl, apiKey });
    return agent.probe
      ? agent.probe()
      : { available: false, error: "BFF probe unavailable" };
  },
);

async function getAgentStatusForRender(): Promise<AgentStatus> {
  const result = await probeBffForRender(
    process.env.BFF_BASE_URL || "https://bff.example",
    process.env.BFF_API_KEY || "missing",
  );
  if (result.available) return result;
  return {
    available: false,
    error: sanitizeBffError(
      new Error(result.error ?? "BFF unavailable"),
    ).message,
  };
}

export async function getDemoRuntime(store: SessionRepository) {
  try {
    loadServerConfig();
  } catch {
    // Local defaults remain authoritative when optional connected config is incomplete.
  }

  let snapshot: DemoSnapshot;
  try {
    snapshot = await store.getSnapshot();
  } catch (error) {
    if (error instanceof StoreDegradedError) {
      snapshot = await store.getSnapshotUnsafe();
    } else {
      throw error;
    }
  }

  const healthcareMode = snapshot.healthcareMode;
  const agentMode = snapshot.agentMode;

  const healthcare =
    healthcareMode === "medplum"
      ? createMedplumHealthcareRepository({
          baseUrl: process.env.MEDPLUM_BASE_URL || "https://api.medplum.example",
          clientId: process.env.MEDPLUM_CLIENT_ID || "missing",
          clientSecret: process.env.MEDPLUM_CLIENT_SECRET || "missing",
          projectId: process.env.MEDPLUM_PROJECT_ID || "missing",
        })
      : createLocalHealthcareRepository(() => snapshot);

  // Conversational boundary: BFF classifies intent when AGENT_MODE=bff.
  // Domain answers and proposals stay server-owned; mutation receipts for the
  // local synthetic healthcare path come from an independent synthetic executor.
  const agent =
    agentMode === "bff"
      ? createBffAgentAdapter({
          baseUrl: process.env.BFF_BASE_URL || "https://bff.example",
          apiKey: process.env.BFF_API_KEY || "missing",
        })
      : createSyntheticAgentAdapter();

  const actionExecutor =
    agentMode === "bff" && healthcareMode === "local"
      ? createSyntheticAgentAdapter()
      : agent;

  const actions = new ActionService(store, actionExecutor);

  return {
    store,
    healthcare,
    agent,
    actions,
    config: {
      ...publicAdapterStatus({
        healthcareMode,
        agentMode,
        medplumBaseUrl: process.env.MEDPLUM_BASE_URL,
        medplumClientId: process.env.MEDPLUM_CLIENT_ID,
        medplumClientSecret: process.env.MEDPLUM_CLIENT_SECRET,
        medplumProjectId: process.env.MEDPLUM_PROJECT_ID,
        bffBaseUrl: process.env.BFF_BASE_URL,
        bffApiKey: process.env.BFF_API_KEY,
      }),
      limitations: healthcare.describeLimitations(),
    },
  };
}

function stripBffProposals(
  episodes: ClaimEpisode[],
  agentStatus: { available: boolean; error?: string },
): ClaimEpisode[] {
  if (agentStatus.available) return episodes;
  return episodes.map((episode) => ({
    ...episode,
    proposal: null,
    resolutionState:
      episode.resolutionState === "approval_required"
        ? ("investigating" as const)
        : episode.resolutionState,
    agentAction: "BFF unavailable",
    issue: agentStatus.error ?? "BFF unavailable",
  }));
}

const buildDemoViewModel = async (store: SessionRepository) => {
  const runtime = await getDemoRuntime(store);

  try {
    if (runtime.store.getDegraded()) {
      const degraded = runtime.store.getDegraded()!;
      return {
        ok: false as const,
        error: degraded.reason,
        recovery: degraded.recovery,
        config: runtime.config,
      };
    }
  } catch {
    // continue
  }

  let agentStatus: AgentStatus = {
    available: true,
  };
  if (runtime.config.agentMode === "bff") {
    agentStatus = await getAgentStatusForRender();
  }

  let snapshot: DemoSnapshot;
  let connectedWritesAvailable = true;

  if (runtime.healthcare.mode === "medplum") {
    try {
      snapshot = await runtime.healthcare.readSnapshot();
      snapshot = {
        ...snapshot,
        agentMode: runtime.config.agentMode,
        healthcareMode: "medplum",
      };
      connectedWritesAvailable = false;
    } catch (error) {
      const sanitized = sanitizeMedplumError(error);
      return {
        ok: false as const,
        error: sanitized.message,
        config: runtime.config,
      };
    }
  } else {
    try {
      snapshot = await runtime.store.getSnapshot();
    } catch (error) {
      if (error instanceof StoreDegradedError) {
        return {
          ok: false as const,
          error: error.message,
          recovery: error.recovery,
          config: runtime.config,
        };
      }
      throw error;
    }
  }

  const episodesRaw =
    runtime.config.agentMode === "bff"
      ? stripBffProposals(snapshot.episodes, agentStatus)
      : snapshot.episodes;

  const episodes = projectEpisodes(episodesRaw);
  const kpi = computeDashboardKpi(episodesRaw);
  const queues = buildQueues(episodesRaw);

  return {
    ok: true as const,
    config: {
      ...runtime.config,
      connectedWritesAvailable,
    },
    snapshot,
    episodes,
    kpi,
    queues,
    demoClock: snapshot.demoClock,
    sessionRevision: snapshot.sessionRevision,
    agentStatus,
    dataSource: runtime.healthcare.mode === "medplum" ? "medplum" : "local",
  };
};

export const getDemoViewModel = cache(buildDemoViewModel);

export async function getEpisodeView(episodeId: string, store: SessionRepository) {
  const runtime = await getDemoRuntime(store);

  let snapshot: DemoSnapshot;
  if (runtime.healthcare.mode === "medplum") {
    try {
      snapshot = await runtime.healthcare.readSnapshot();
    } catch {
      return null;
    }
  } else {
    try {
      snapshot = await runtime.store.getSnapshot();
    } catch (error) {
      if (error instanceof StoreDegradedError) return null;
      throw error;
    }
  }

  let episode = snapshot.episodes.find((e) => e.id === episodeId);
  if (!episode) return null;

  if (runtime.config.agentMode === "bff") {
    const status = await getAgentStatusForRender();
    if (!status.available) {
      episode = {
        ...episode,
        proposal: null,
        issue: status.error ?? "Connect BFF to generate agent proposals",
      };
    }
  }

  const view = enrichEpisode(episode);
  const preflight =
    episode.fixtureKey === "encounter-a" ||
    episode.fixtureKey === "connected-encounter"
      ? runPreflight(episode)
      : null;
  return {
    episode: view,
    preflight,
    config: runtime.config,
    dataSource: runtime.healthcare.mode === "medplum" ? "medplum" : "local",
    events:
      runtime.healthcare.mode === "medplum"
        ? []
        : snapshot.events.filter(
            (e) => "episodeId" in e && e.episodeId === episodeId,
          ),
  };
}
