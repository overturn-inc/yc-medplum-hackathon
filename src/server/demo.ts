import { createBffAgentAdapter } from "@/adapters/agent/bff";
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
import {
  createMossCloudRetrievalAdapter,
  createMossSidecarRetrievalAdapter,
} from "@/adapters/retrieval/moss";
import { loadServerConfig, publicAdapterStatus } from "@/server/config";
import {
  classifyFhirPlaneStatus,
  PAYER_WRITES_MODE,
  sessionLedgerBackend,
} from "@/server/fhir-plane";
import { StoreDegradedError } from "@/server/store";
import type { SessionRepository } from "@/server/repository";

type AgentStatus = { available: boolean; error?: string };

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
  const mossConfigured = Boolean(
    process.env.MOSS_MODE === "live" &&
      process.env.MOSS_INDEX_NAME &&
      (process.env.MOSS_EXECUTION === "sidecar"
        ? process.env.MOSS_SIDECAR_URL && process.env.MOSS_SIDECAR_API_KEY
        : process.env.MOSS_PROJECT_ID && process.env.MOSS_PROJECT_KEY),
  );
  const retrieval = mossConfigured
    ? process.env.MOSS_EXECUTION === "sidecar"
      ? createMossSidecarRetrievalAdapter({
          endpoint: process.env.MOSS_SIDECAR_URL!,
          apiKey: process.env.MOSS_SIDECAR_API_KEY!,
          indexName: process.env.MOSS_INDEX_NAME!,
        })
      : createMossCloudRetrievalAdapter({
          projectId: process.env.MOSS_PROJECT_ID!,
          projectKey: process.env.MOSS_PROJECT_KEY!,
          indexName: process.env.MOSS_INDEX_NAME!,
          preferredExecution:
            process.env.MOSS_EXECUTION === "local" ? "local" : "cloud",
        })
    : null;

  const adapterStatus = publicAdapterStatus({
    healthcareMode,
    agentMode,
    medplumBaseUrl: process.env.MEDPLUM_BASE_URL,
    medplumClientId: process.env.MEDPLUM_CLIENT_ID,
    medplumClientSecret: process.env.MEDPLUM_CLIENT_SECRET,
    medplumProjectId: process.env.MEDPLUM_PROJECT_ID,
    bffBaseUrl: process.env.BFF_BASE_URL,
    bffApiKey: process.env.BFF_API_KEY,
    stediMode: process.env.STEDI_MODE === "test" ? "test" : "off",
    stediBaseUrl: process.env.STEDI_BASE_URL,
    stediApiKey: process.env.STEDI_API_KEY,
    mossMode: process.env.MOSS_MODE === "live" ? "live" : "off",
    mossExecution:
      process.env.MOSS_EXECUTION === "local"
        ? "local"
        : process.env.MOSS_EXECUTION === "sidecar"
          ? "sidecar"
          : "cloud",
    mossProjectId: process.env.MOSS_PROJECT_ID,
    mossProjectKey: process.env.MOSS_PROJECT_KEY,
    mossIndexName: process.env.MOSS_INDEX_NAME,
    mossSidecarUrl: process.env.MOSS_SIDECAR_URL,
    mossSidecarApiKey: process.env.MOSS_SIDECAR_API_KEY,
  });

  return {
    store,
    healthcare,
    agent,
    actions,
    retrieval,
    config: {
      ...adapterStatus,
      // `connected` is intentionally omitted here: it is only known once a
      // live Medplum read/write has actually been attempted (see
      // `buildDemoViewModel`), never guessed from config alone.
      fhirPlaneStatus: classifyFhirPlaneStatus({
        healthcareMode,
        medplumConfigured: adapterStatus.medplumConfigured,
      }),
      sessionLedgerBackend: sessionLedgerBackend(),
      payerWritesMode: PAYER_WRITES_MODE,
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

  // Page reads must not synchronously health-check the remote agent. Doing so
  // put the BFF network round trip on every navigation's critical render path.
  // Configuration errors can be reported immediately; operational readiness
  // is checked at the chat/approval API boundary where failures are visible and
  // approved actions remain fail-closed with no synthetic fallback.
  const agentStatus: AgentStatus =
    runtime.config.agentMode === "bff" && !runtime.config.bffConfigured
      ? { available: false, error: "BFF is not configured" }
      : { available: true };

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
      // Only a real, successful Medplum read may report the FHIR plane as
      // connected; config alone (see `getDemoRuntime`) can only say whether
      // it is configured.
      runtime.config.fhirPlaneStatus = "connected";
    } catch (error) {
      const sanitized = sanitizeMedplumError(error);
      return {
        ok: false as const,
        error: sanitized.message,
        config: { ...runtime.config, fhirPlaneStatus: "unavailable" as const },
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
      runtime.config.fhirPlaneStatus = "connected";
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

  if (runtime.config.agentMode === "bff" && !runtime.config.bffConfigured) {
    episode = {
      ...episode,
      proposal: null,
      issue: "Connect BFF to generate agent proposals",
    };
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
