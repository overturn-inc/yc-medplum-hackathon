import type {
  AgentAdapter,
  AgentExecuteInput,
  AgentExecuteResult,
  AgentStreamEvent,
} from "./types";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const CONTRACT_VERSION = "v1";
const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_MUTATION_RETRIES = 1;

/** Breakfast Factory CreateThreadRequest — exact wire shape. */
export interface CreateThreadRequest {
  readonly client_request_id: string;
}

/** Breakfast Factory CreateRunRequest — exact wire shape. */
export interface CreateRunRequest {
  readonly client_request_id: string;
  readonly prompt: string;
}

export interface ThreadRecord {
  readonly thread_id: string;
  readonly active_run_id?: string | null;
  readonly latest_run_id?: string | null;
  readonly [key: string]: unknown;
}

export interface RunRecord {
  readonly run_id: string;
  readonly thread_id: string;
  readonly client_request_id: string;
  readonly state?: string;
  readonly [key: string]: unknown;
}

/** Minimal RunEventV1 terminal/prefix fields used by this demo boundary. */
export interface RunEventV1 {
  readonly run_id: string;
  readonly run_event_index: number;
  readonly event_type: string;
  readonly event_id?: string;
  readonly contract_version?: string;
  readonly occurred_at?: string;
  readonly run_state?: string;
  readonly payload?: unknown;
  readonly [key: string]: unknown;
}

export class BffAdapterError extends Error {
  readonly code:
    | "BFF_UNAVAILABLE"
    | "BFF_REJECTED"
    | "BFF_UNKNOWN_OUTCOME"
    | "BFF_INVALID_RESPONSE";
  readonly status: number;

  constructor(
    code: BffAdapterError["code"],
    message: string,
    status = 503,
  ) {
    super(message);
    this.name = "BffAdapterError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDefinitiveMutationRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Connected BFF v1 HTTP adapter matching Breakfast Factory ApiClient shapes.
 * Never falls back to synthetic execution.
 */
export function createBffAgentAdapter(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}): AgentAdapter & {
  createThread: (request: CreateThreadRequest) => Promise<ThreadRecord>;
  createRun: (threadId: string, request: CreateRunRequest) => Promise<RunRecord>;
  consumeEvents: (
    runId: string,
    options?: { lastEventId?: number },
  ) => Promise<RunEventV1[]>;
} {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.endsWith("/")
    ? input.baseUrl
    : `${input.baseUrl}/`;
  /** Per-run durable cursors and dedupe sets. Never shared across runs. */
  const cursors = new Map<string, number>();
  const seenByRun = new Map<string, Set<string>>();
  let activeRunId: string | null = null;
  const normalizedEvents: AgentStreamEvent[] = [];

  function headers(extra?: HeadersInit): HeadersInit {
    return {
      accept: "application/json",
      authorization: `Bearer ${input.apiKey}`,
      "x-bff-contract-version": CONTRACT_VERSION,
      "content-type": "application/json",
      ...extra,
    };
  }

  function seenSet(runId: string): Set<string> {
    let set = seenByRun.get(runId);
    if (!set) {
      set = new Set();
      seenByRun.set(runId, set);
    }
    return set;
  }

  async function send(
    method: string,
    path: string,
    body?: string,
    extraHeaders?: HeadersInit,
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), base);
    try {
      return await fetchImpl(url, {
        method,
        headers: headers(extraHeaders),
        body,
      });
    } catch (error) {
      throw new BffAdapterError(
        "BFF_UNKNOWN_OUTCOME",
        sanitizeBffError(error).message ||
          "mutation response was not received; retry used the same client_request_id",
        503,
      );
    }
  }

  async function mutateJson<T>(
    method: "POST",
    path: string,
    body: object,
    validate: (value: unknown) => T,
  ): Promise<T> {
    const serialized = JSON.stringify(body);
    let lastError: BffAdapterError | undefined;
    for (let attempt = 0; attempt <= MAX_MUTATION_RETRIES; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await send(method, path, serialized);
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          throw new BffAdapterError(
            "BFF_UNKNOWN_OUTCOME",
            "mutation outcome was not confirmed; retry used the same client_request_id",
            response.status,
          );
        }
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          throw new BffAdapterError(
            "BFF_UNKNOWN_OUTCOME",
            "mutation outcome was not confirmed; retry used the same client_request_id",
            response.status,
          );
        }
        if (!response.ok) {
          if (isDefinitiveMutationRejection(response.status)) {
            throw new BffAdapterError(
              "BFF_REJECTED",
              `BFF rejected mutation with ${response.status}`,
              response.status,
            );
          }
          throw new BffAdapterError(
            "BFF_UNKNOWN_OUTCOME",
            "mutation outcome was not confirmed; retry used the same client_request_id",
            response.status,
          );
        }
        return validate(parsed);
      } catch (error) {
        const outcome =
          error instanceof BffAdapterError
            ? error
            : new BffAdapterError(
                "BFF_UNKNOWN_OUTCOME",
                "mutation outcome was not confirmed; retry used the same client_request_id",
              );
        lastError = outcome;
        if (
          outcome.code !== "BFF_UNKNOWN_OUTCOME" ||
          attempt === MAX_MUTATION_RETRIES
        ) {
          throw outcome;
        }
      }
    }
    throw (
      lastError ??
      new BffAdapterError(
        "BFF_UNKNOWN_OUTCOME",
        "mutation outcome was not confirmed; retry used the same client_request_id",
      )
    );
  }

  function validateThread(value: unknown): ThreadRecord {
    if (!isRecord(value) || !isIdentifier(value.thread_id)) {
      throw new BffAdapterError(
        "BFF_UNKNOWN_OUTCOME",
        "mutation outcome was not confirmed; invalid thread body",
      );
    }
    return value as ThreadRecord;
  }

  function validateRun(
    value: unknown,
    threadId: string,
    clientRequestId: string,
  ): RunRecord {
    if (
      !isRecord(value) ||
      !isIdentifier(value.run_id) ||
      !isIdentifier(value.thread_id) ||
      !isIdentifier(value.client_request_id)
    ) {
      throw new BffAdapterError(
        "BFF_UNKNOWN_OUTCOME",
        "mutation outcome was not confirmed; invalid run body",
      );
    }
    if (
      value.thread_id !== threadId ||
      value.client_request_id !== clientRequestId
    ) {
      throw new BffAdapterError(
        "BFF_UNKNOWN_OUTCOME",
        "mutation outcome was not confirmed; run relational binding failed",
      );
    }
    return value as RunRecord;
  }

  function validateRunEvent(value: unknown, runId: string): RunEventV1 {
    if (
      !isRecord(value) ||
      !isIdentifier(value.run_id) ||
      typeof value.run_event_index !== "number" ||
      typeof value.event_type !== "string"
    ) {
      throw new BffAdapterError(
        "BFF_INVALID_RESPONSE",
        "server returned an invalid run event",
      );
    }
    if (value.run_id !== runId) {
      throw new BffAdapterError(
        "BFF_INVALID_RESPONSE",
        "server event run_id does not match requested run",
      );
    }
    return value as RunEventV1;
  }

  async function createThread(
    request: CreateThreadRequest,
  ): Promise<ThreadRecord> {
    return mutateJson("POST", "v1/threads", request, validateThread);
  }

  async function createRun(
    threadId: string,
    request: CreateRunRequest,
  ): Promise<RunRecord> {
    return mutateJson(
      "POST",
      `v1/threads/${encodeURIComponent(threadId)}/runs`,
      request,
      (value) => validateRun(value, threadId, request.client_request_id),
    );
  }

  async function consumeEventsOnce(
    runId: string,
    lastEventId?: number,
  ): Promise<RunEventV1[]> {
    const cursor = lastEventId ?? cursors.get(runId) ?? 0;
    const response = await send(
      "GET",
      `v1/runs/${encodeURIComponent(runId)}/events`,
      undefined,
      {
        accept: "text/event-stream",
        ...(cursor > 0 ? { "last-event-id": String(cursor) } : {}),
      },
    );
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new BffAdapterError(
          "BFF_UNAVAILABLE",
          `BFF event stream unavailable (${response.status})`,
          response.status,
        );
      }
      throw new BffAdapterError(
        "BFF_INVALID_RESPONSE",
        `BFF event stream failed with ${response.status}`,
        response.status,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const events: RunEventV1[] = [];
    const seen = seenSet(runId);

    if (contentType.includes("text/event-stream") || text.includes("data:")) {
      for (const block of text.split(/\n\n+/)) {
        const lines = block.split("\n");
        let id: string | undefined;
        let data: string | undefined;
        for (const line of lines) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new BffAdapterError(
            "BFF_INVALID_RESPONSE",
            "server returned invalid event JSON",
          );
        }
        const event = validateRunEvent(parsed, runId);
        if (id === undefined || id !== String(event.run_event_index)) {
          throw new BffAdapterError(
            "BFF_INVALID_RESPONSE",
            "server event SSE ID does not match durable cursor",
          );
        }
        const dedupeKey = `${event.run_id}:${event.run_event_index}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        cursors.set(runId, Math.max(cursors.get(runId) ?? 0, event.run_event_index));
        events.push(event);
        normalizedEvents.push({
          id: `${event.run_id}:${event.run_event_index}`,
          cursor: String(event.run_event_index),
          kind: event.event_type,
          payload: event,
        });
      }
    } else {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) {
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "server returned invalid event list",
        );
      }
      for (const item of parsed) {
        const event = validateRunEvent(item, runId);
        const dedupeKey = `${event.run_id}:${event.run_event_index}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        cursors.set(runId, Math.max(cursors.get(runId) ?? 0, event.run_event_index));
        events.push(event);
        normalizedEvents.push({
          id: `${event.run_id}:${event.run_event_index}`,
          cursor: String(event.run_event_index),
          kind: event.event_type,
          payload: event,
        });
      }
    }
    return events;
  }

  async function consumeEvents(
    runId: string,
    options?: { lastEventId?: number },
  ): Promise<RunEventV1[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        return await consumeEventsOnce(
          runId,
          options?.lastEventId ?? cursors.get(runId),
        );
      } catch (error) {
        lastError = error;
        if (
          error instanceof BffAdapterError &&
          error.code === "BFF_INVALID_RESPONSE" &&
          !/unavailable|transport/i.test(error.message)
        ) {
          throw error;
        }
      }
    }
    throw (
      lastError ??
      new BffAdapterError(
        "BFF_UNAVAILABLE",
        "BFF event stream reconnect exhausted",
      )
    );
  }

  return {
    mode: "bff",
    createThread,
    createRun,
    consumeEvents,
    async probe() {
      try {
        const response = await send("GET", "v1/readiness");
        if (!response.ok) {
          return {
            available: false,
            error: `BFF readiness failed with ${response.status}`,
          };
        }
        return { available: true };
      } catch (error) {
        return {
          available: false,
          error: sanitizeBffError(error).message,
        };
      }
    },
    async executeApprovedAction(
      exec: AgentExecuteInput,
    ): Promise<AgentExecuteResult> {
      const clientRequestId = exec.idempotencyKey;
      const prompt = JSON.stringify({
        actionType: exec.actionType,
        episodeId: exec.episodeId,
        payloadDigest: exec.payloadDigest,
      });
      try {
        const thread = await createThread({
          client_request_id: clientRequestId,
        });
        const run = await createRun(thread.thread_id, {
          client_request_id: clientRequestId,
          prompt,
        });
        activeRunId = run.run_id;
        const events = await consumeEvents(run.run_id);
        const terminal = [...events]
          .reverse()
          .find((e) =>
            [
              "run_completed",
              "run_failed_fatal",
              "run_outcome_unknown",
              "run_cancelled",
            ].includes(e.event_type),
          );
        if (!terminal) {
          return {
            outcome: "pending_verification",
            message:
              "BFF run produced no terminal event; outcome pending verification",
          };
        }
        if (terminal.event_type === "run_failed_fatal") {
          return {
            outcome: "failed",
            message: "BFF run_failed_fatal; approved action was not completed",
          };
        }
        if (
          terminal.event_type === "run_outcome_unknown" ||
          terminal.event_type === "run_cancelled"
        ) {
          return {
            outcome: "pending_verification",
            message: `BFF ${terminal.event_type}; pending verification`,
          };
        }
        return {
          outcome: "success",
          message: "BFF run_completed",
          receiptId: `bff-receipt-${run.run_id}`,
        };
      } catch (error) {
        if (error instanceof BffAdapterError) {
          if (error.code === "BFF_REJECTED") {
            return {
              outcome: "failed",
              message: sanitizeBffError(error).message,
            };
          }
          if (
            error.code === "BFF_UNKNOWN_OUTCOME" ||
            error.code === "BFF_UNAVAILABLE" ||
            error.code === "BFF_INVALID_RESPONSE"
          ) {
            return {
              outcome: "pending_verification",
              message: sanitizeBffError(error).message,
            };
          }
        }
        return {
          outcome: "pending_verification",
          message: sanitizeBffError(error).message,
        };
      }
    },
    async listEvents(resumeCursor?: string): Promise<AgentStreamEvent[]> {
      if (!activeRunId) {
        throw Object.assign(
          new Error("BFF stream listing requires an active run"),
          { status: 503, code: "BFF_UNAVAILABLE" },
        );
      }
      const events = await consumeEvents(activeRunId, {
        lastEventId: resumeCursor ? Number(resumeCursor) : undefined,
      });
      return events
        .filter((e) =>
          resumeCursor ? e.run_event_index > Number(resumeCursor) : true,
        )
        .map((event) => ({
          id: `${event.run_id}:${event.run_event_index}`,
          cursor: String(event.run_event_index),
          kind: event.event_type,
          payload: event,
        }));
    },
  };
}

export function sanitizeBffError(error: unknown): {
  message: string;
  status: number;
} {
  const message =
    error instanceof Error
      ? error.message
          .replace(/Bearer\s+\S+/gi, "[redacted]")
          .replace(/api[_-]?key\s*[:=]?\s*\S+/gi, "api_key=[redacted]")
          .replace(/client_request_id["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, "client_request_id=[redacted]")
      : "BFF error";
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status: number }).status)
      : 503;
  return { message, status };
}
