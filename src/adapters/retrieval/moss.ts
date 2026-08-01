import { z } from "zod";
import type {
  RetrievalAdapter,
  RetrievalQuery,
  RetrievalResult,
} from "@/adapters/retrieval/types";

const DEFAULT_AUTH_URL = "https://service.usemoss.dev/identity/auth/token";
const DEFAULT_QUERY_URL = "https://service.usemoss.dev/query";

const authResponseSchema = z.object({
  token: z.string().min(1),
  expiresIn: z.number().positive(),
});

const queryResponseSchema = z.object({
  query: z.string().optional(),
  indexName: z.string().optional(),
  timeTakenInMs: z.number().nonnegative().optional(),
  docs: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      score: z.number(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

export interface MossCloudConfig {
  projectId: string;
  projectKey: string;
  indexName: string;
  authUrl?: string;
  queryUrl?: string;
  fetchImpl?: typeof fetch;
  preferredExecution?: "cloud" | "local";
}

interface LocalMossClient {
  loadIndex(indexName: string): Promise<string>;
  query(
    indexName: string,
    query: string,
    options: { topK: number; filter: unknown },
  ): Promise<z.infer<typeof queryResponseSchema>>;
}

export class MossRetrievalError extends Error {
  constructor(message: string, readonly status = 503) {
    super(message);
    this.name = "MossRetrievalError";
  }
}

export class MossCloudRetrievalAdapter implements RetrievalAdapter {
  readonly provider = "moss" as const;
  private readonly fetchImpl: typeof fetch;
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private localClientPromise: Promise<LocalMossClient> | null = null;

  constructor(private readonly config: MossCloudConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async query(input: RetrievalQuery): Promise<RetrievalResult> {
    if (this.config.preferredExecution === "local") {
      return this.queryLocal(input);
    }

    return this.queryCloud(input);
  }

  private async queryCloud(input: RetrievalQuery): Promise<RetrievalResult> {
    const startedAt = performance.now();
    const token = await this.getToken();
    const response = await this.fetchImpl(this.config.queryUrl ?? DEFAULT_QUERY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        indexName: this.config.indexName,
        // Query broadly, then enforce episode isolation on trusted metadata.
        topK: Math.max(input.topK ?? 20, 20),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new MossRetrievalError("Moss semantic retrieval is unavailable");
    });

    if (!response.ok) {
      throw new MossRetrievalError(
        "Moss semantic retrieval was rejected",
        response.status === 401 || response.status === 403 ? 503 : 502,
      );
    }

    const parsed = queryResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new MossRetrievalError("Moss returned an invalid retrieval response", 502);
    }

    const documents = parsed.data.docs
      .filter((doc) => doc.metadata?.episodeId === input.episodeId)
      .slice(0, input.topK ?? 4)
      .map((doc) => ({
        id: doc.id,
        title: doc.metadata?.title ?? doc.id,
        reference: doc.metadata?.sourceReference ?? "Unknown source",
        documentType: doc.metadata?.documentType ?? "unknown",
        excerpt: doc.text.length > 240 ? `${doc.text.slice(0, 237)}...` : doc.text,
        score: doc.score,
      }));

    return {
      provider: "moss",
      indexName: this.config.indexName,
      execution: "cloud-semantic-search",
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      mossSearchMs: parsed.data.timeTakenInMs ?? null,
      synthetic: true,
      documents,
    };
  }

  private async queryLocal(input: RetrievalQuery): Promise<RetrievalResult> {
    const startedAt = performance.now();
    const client = await this.getLocalClient();
    const queryStartedAt = performance.now();
    const result = await client.query(this.config.indexName, input.query, {
      topK: input.topK ?? 4,
      filter: { field: "episodeId", condition: { $eq: input.episodeId } },
    });
    const parsed = queryResponseSchema.safeParse(result);
    if (!parsed.success) {
      throw new MossRetrievalError("Moss returned an invalid local retrieval response", 502);
    }
    const documents = parsed.data.docs
      .filter((doc) => doc.metadata?.episodeId === input.episodeId)
      .slice(0, input.topK ?? 4)
      .map((doc) => ({
        id: doc.id,
        title: doc.metadata?.title ?? doc.id,
        reference: doc.metadata?.sourceReference ?? "Unknown source",
        documentType: doc.metadata?.documentType ?? "unknown",
        excerpt: doc.text.length > 240 ? `${doc.text.slice(0, 237)}...` : doc.text,
        score: doc.score,
      }));
    return {
      provider: "moss",
      indexName: this.config.indexName,
      execution: "local-in-memory",
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      mossSearchMs: Math.round((performance.now() - queryStartedAt) * 10) / 10,
      synthetic: true,
      documents,
    };
  }

  private async getLocalClient(): Promise<LocalMossClient> {
    if (this.localClientPromise) return this.localClientPromise;
    this.localClientPromise = (async () => {
      // Keep the native Node SDK out of the Cloudflare worker bundle. Local
      // demos and the Node voice gateway resolve it at runtime; hosted workers
      // use the cloud API path instead.
      const packageName = ["@moss-dev", "moss"].join("/");
      const sdkModule = (await import(
        /* @vite-ignore */ /* webpackIgnore: true */ packageName
      )) as {
        MossClient: new (projectId: string, projectKey: string) => LocalMossClient;
      };
      const client = new sdkModule.MossClient(
        this.config.projectId,
        this.config.projectKey,
      );
      await client.loadIndex(this.config.indexName);
      return client;
    })().catch(() => {
      this.localClientPromise = null;
      throw new MossRetrievalError("Moss local retrieval is unavailable");
    });
    return this.localClientPromise;
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }

    const response = await this.fetchImpl(this.config.authUrl ?? DEFAULT_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: this.config.projectId,
        projectKey: this.config.projectKey,
      }),
      signal: AbortSignal.timeout(7_500),
    }).catch(() => {
      throw new MossRetrievalError("Moss authentication is unavailable");
    });

    if (!response.ok) {
      throw new MossRetrievalError("Moss authentication failed");
    }

    const parsed = authResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new MossRetrievalError("Moss returned an invalid authentication response");
    }

    this.tokenCache = {
      token: parsed.data.token,
      expiresAt: Date.now() + Math.max(parsed.data.expiresIn - 60, 30) * 1_000,
    };
    return parsed.data.token;
  }
}

let cachedAdapter:
  | { signature: string; adapter: MossCloudRetrievalAdapter }
  | undefined;

export function createMossCloudRetrievalAdapter(
  config: MossCloudConfig,
): MossCloudRetrievalAdapter {
  const signature = `${config.projectId}:${config.indexName}:${config.projectKey}`;
  if (cachedAdapter?.signature === signature && !config.fetchImpl) {
    return cachedAdapter.adapter;
  }
  const adapter = new MossCloudRetrievalAdapter(config);
  if (!config.fetchImpl) cachedAdapter = { signature, adapter };
  return adapter;
}
