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
/** Bound the SSE response buffer so a misbehaving BFF cannot exhaust memory. */
const MAX_SSE_BUFFER_BYTES = 1_000_000;
const MAX_SSE_BUFFER_EVENTS = 256;

/** RunEventV1 primitive patterns, mirrored exactly from the BF contract. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const UTC_TIMESTAMP_PATTERN =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$/;

const ATTEMPT_STOPPED_ERROR_CODES = new Set([
  "MODEL_RESPONSE_INVALID",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_ADAPTER_ERROR",
  "MODEL_PROVIDER_FATAL",
  "MODEL_RETRY_EXHAUSTED",
  "MODEL_REUSED_COMPLETED_TOOL_CALL_ID",
  "STALE_ATTEMPT_GENERATION",
  "INVALID_HARD_DEADLINE",
  "RECOVERY_PRECONDITION_FAILED",
  "UNSAFE_TOOL_REOBSERVATION",
  "REPEATED_TOOL_FAILURE",
  "TERMINAL_CLEANUP_FAILED",
  "MODEL_OUTCOME_UNKNOWN",
]);

type PayloadKind =
  | "empty"
  | "attempt_started"
  | "model_call_requested"
  | "model_call_rejected_preaccept"
  | "model_response_completed"
  | "tool_call_started"
  | "tool_result_completed"
  | "attempt_stopped"
  | "attempt_rollover_ready"
  | "run_completed"
  | "failure"
  | "reconciliation"
  | "context_compaction";

interface EventSpec {
  origin: "server" | "runtime";
  runState: string;
  needsReconciliation: boolean;
  attemptId: "null" | "id";
  attemptSequence: "null" | "number";
  payloadKind: PayloadKind;
}

/** Closed catalog of RunEventV1 event_type variants; exactly mirrors run-event.v1.json. */
const EVENT_SPECS: Record<string, EventSpec> = {
  run_queued: {
    origin: "server",
    runState: "queued",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "empty",
  },
  run_activated: {
    origin: "server",
    runState: "active",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "empty",
  },
  attempt_started: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "attempt_started",
  },
  attempt_superseded: {
    origin: "server",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "null",
    payloadKind: "empty",
  },
  model_call_requested: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "model_call_requested",
  },
  model_call_rejected_preaccept: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "model_call_rejected_preaccept",
  },
  model_response_completed: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "model_response_completed",
  },
  tool_call_started: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "tool_call_started",
  },
  tool_result_completed: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "tool_result_completed",
  },
  attempt_completed: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "empty",
  },
  attempt_stopped: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "attempt_stopped",
  },
  attempt_rollover_ready: {
    origin: "runtime",
    runState: "active",
    needsReconciliation: false,
    attemptId: "id",
    attemptSequence: "number",
    payloadKind: "attempt_rollover_ready",
  },
  run_completed: {
    origin: "server",
    runState: "completed",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "run_completed",
  },
  run_cancelled: {
    origin: "server",
    runState: "cancelled",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "empty",
  },
  run_failed_fatal: {
    origin: "server",
    runState: "failed_fatal",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "failure",
  },
  run_outcome_unknown: {
    origin: "server",
    runState: "outcome_unknown",
    needsReconciliation: true,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "reconciliation",
  },
  reconciliation_required: {
    origin: "server",
    runState: "outcome_unknown",
    needsReconciliation: true,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "reconciliation",
  },
  cancellation_requested: {
    origin: "server",
    runState: "cancel_requested",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "empty",
  },
  context_compaction_committed: {
    origin: "server",
    runState: "active",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "context_compaction",
  },
  runtime_migrated: {
    origin: "server",
    runState: "active",
    needsReconciliation: false,
    attemptId: "null",
    attemptSequence: "null",
    payloadKind: "empty",
  },
};

/** Terminal run_event types: no further events may follow one in a stream. */
const TERMINAL_EVENT_TYPES = new Set([
  "run_completed",
  "run_cancelled",
  "run_failed_fatal",
  "run_outcome_unknown",
  "reconciliation_required",
]);

const RUN_EVENT_KEYS = [
  "contract_version",
  "event_id",
  "run_id",
  "attempt_id",
  "origin",
  "attempt_sequence",
  "run_event_index",
  "event_type",
  "occurred_at",
  "run_state",
  "needs_reconciliation",
  "payload",
] as const;

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

/** Closed RunEventV1 shape, validated exactly against run-event.v1.json. */
export interface RunEventV1 {
  readonly contract_version: "v1";
  readonly event_id: string;
  readonly run_id: string;
  readonly attempt_id: string | null;
  readonly origin: "server" | "runtime";
  readonly attempt_sequence: number | null;
  readonly run_event_index: number;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly run_state: string;
  readonly needs_reconciliation: boolean;
  readonly payload: Record<string, unknown>;
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
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extract the closed classifier JSON document from BFF assistant content.
 *
 * Accepts only:
 * - a raw JSON object string (after outer trim), or
 * - exactly one complete markdown fence labeled `json` whose body is the
 *   JSON document alone (Bedrock Claude's observed form).
 *
 * Rejects prefix/suffix prose, multiple fences, unlabeled fences, and
 * anything that is not already raw JSON or that single labeled fence.
 * Does not invent a synthetic fallback.
 */
export function extractClassifierJsonDocument(rawContent: string): string {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new BffAdapterError(
      "BFF_INVALID_RESPONSE",
      "BFF conversation classifier returned empty assistant content",
      502,
    );
  }

  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  // Exact form: ```json\n<document>\n``` with optional CRLF. Anchored so any
  // surrounding prose or a second fence fails.
  const fenced = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (!fenced) {
    throw new BffAdapterError(
      "BFF_INVALID_RESPONSE",
      "BFF conversation classifier returned non-JSON content",
      502,
    );
  }

  const body = fenced[1]!.trim();
  if (!body || body.includes("```") || !body.startsWith("{")) {
    throw new BffAdapterError(
      "BFF_INVALID_RESPONSE",
      "BFF conversation classifier returned non-JSON content",
      502,
    );
  }
  return body;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDefinitiveMutationRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function invalidEvent(message: string): never {
  throw new BffAdapterError("BFF_INVALID_RESPONSE", message);
}

function requireClosedKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      invalidEvent(`${label} payload has unexpected field "${key}"`);
    }
  }
  for (const key of required) {
    if (!(key in payload)) {
      invalidEvent(`${label} payload is missing required field "${key}"`);
    }
  }
}

function isNonNegativeInt(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInt(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1;
}

/** Validates a single RunEventV1 payload against its closed event_type shape. */
function validatePayload(
  eventType: string,
  spec: EventSpec,
  payload: Record<string, unknown>,
): void {
  switch (spec.payloadKind) {
    case "empty": {
      requireClosedKeys(payload, ["kind"], ["kind"], eventType);
      if (payload.kind !== "none") {
        invalidEvent(`${eventType} payload.kind must be "none"`);
      }
      return;
    }
    case "run_completed": {
      requireClosedKeys(
        payload,
        ["assistant_message"],
        ["assistant_message"],
        eventType,
      );
      const assistantMessage = payload.assistant_message;
      if (!isRecord(assistantMessage)) {
        invalidEvent(
          "run_completed payload.assistant_message must be an object",
        );
      }
      requireClosedKeys(
        assistantMessage,
        ["content"],
        ["content"],
        "assistant_message",
      );
      if (typeof assistantMessage.content !== "string") {
        invalidEvent(
          "run_completed payload.assistant_message.content must be a string",
        );
      }
      return;
    }
    case "failure": {
      requireClosedKeys(payload, ["error_code"], ["error_code"], eventType);
      if (typeof payload.error_code !== "string" || payload.error_code.length === 0) {
        invalidEvent(`${eventType} payload.error_code must be a non-empty string`);
      }
      return;
    }
    case "reconciliation": {
      requireClosedKeys(
        payload,
        ["obligation_id"],
        ["obligation_id"],
        eventType,
      );
      if (
        typeof payload.obligation_id !== "string" ||
        !ID_PATTERN.test(payload.obligation_id)
      ) {
        invalidEvent(`${eventType} payload.obligation_id must be a valid Id`);
      }
      return;
    }
    case "attempt_started": {
      const allowed = [
        "runtime_version",
        "artifact_digest",
        "context_digest",
        "tool_catalog_digest",
        "resumed_from_run_event_index",
        "resumed_context_digest",
        "model_profile",
        "provider_context_digest",
      ];
      const required = [
        "runtime_version",
        "artifact_digest",
        "context_digest",
        "tool_catalog_digest",
        "resumed_from_run_event_index",
        "resumed_context_digest",
      ];
      requireClosedKeys(payload, allowed, required, eventType);
      if (
        typeof payload.runtime_version !== "string" ||
        payload.runtime_version.length === 0
      ) {
        invalidEvent("attempt_started payload.runtime_version is invalid");
      }
      for (const digestKey of [
        "artifact_digest",
        "context_digest",
        "tool_catalog_digest",
        "resumed_context_digest",
      ]) {
        if (!DIGEST_PATTERN.test(String(payload[digestKey] ?? ""))) {
          invalidEvent(`attempt_started payload.${digestKey} is not a valid digest`);
        }
      }
      if (!isNonNegativeInt(payload.resumed_from_run_event_index)) {
        invalidEvent(
          "attempt_started payload.resumed_from_run_event_index is invalid",
        );
      }
      const hasProfile = "model_profile" in payload;
      const hasProviderDigest = "provider_context_digest" in payload;
      if (hasProfile !== hasProviderDigest) {
        invalidEvent(
          "attempt_started payload.model_profile and provider_context_digest must both be present or both absent",
        );
      }
      return;
    }
    case "model_call_requested": {
      requireClosedKeys(
        payload,
        ["model_call_id"],
        ["model_call_id"],
        eventType,
      );
      if (
        typeof payload.model_call_id !== "string" ||
        !ID_PATTERN.test(payload.model_call_id)
      ) {
        invalidEvent(`${eventType} payload.model_call_id is invalid`);
      }
      return;
    }
    case "model_call_rejected_preaccept": {
      requireClosedKeys(
        payload,
        ["model_call_id", "error_code"],
        ["model_call_id", "error_code"],
        eventType,
      );
      if (
        typeof payload.model_call_id !== "string" ||
        !ID_PATTERN.test(payload.model_call_id)
      ) {
        invalidEvent(`${eventType} payload.model_call_id is invalid`);
      }
      if (
        payload.error_code !== "MODEL_PROVIDER_PREACCEPT" &&
        payload.error_code !== "MODEL_PROVIDER_FATAL"
      ) {
        invalidEvent(`${eventType} payload.error_code is invalid`);
      }
      return;
    }
    case "model_response_completed": {
      if (
        typeof payload.model_call_id !== "string" ||
        !ID_PATTERN.test(payload.model_call_id)
      ) {
        invalidEvent(`${eventType} payload.model_call_id is invalid`);
      }
      const hasContent = "assistant_content" in payload;
      const hasMessage = "assistant_message" in payload;
      const hasPartial =
        "stop_reason" in payload && "partial_assistant_content" in payload;
      const variantCount = [hasContent, hasMessage, hasPartial].filter(
        Boolean,
      ).length;
      if (variantCount !== 1) {
        invalidEvent(
          `${eventType} payload must match exactly one known variant`,
        );
      }
      const allowed = hasContent
        ? ["model_call_id", "assistant_content"]
        : hasMessage
          ? ["model_call_id", "assistant_message"]
          : ["model_call_id", "stop_reason", "partial_assistant_content"];
      requireClosedKeys(payload, allowed, allowed, eventType);
      if (hasMessage) {
        const assistantMessage = payload.assistant_message;
        if (
          !isRecord(assistantMessage) ||
          typeof assistantMessage.content !== "string"
        ) {
          invalidEvent(
            `${eventType} payload.assistant_message is invalid`,
          );
        }
      }
      if (hasPartial && payload.stop_reason !== "max_tokens") {
        invalidEvent(`${eventType} payload.stop_reason is invalid`);
      }
      return;
    }
    case "tool_call_started": {
      requireClosedKeys(
        payload,
        ["tool_call_id", "tool_id"],
        ["tool_call_id", "tool_id"],
        eventType,
      );
      if (
        typeof payload.tool_call_id !== "string" ||
        !ID_PATTERN.test(payload.tool_call_id)
      ) {
        invalidEvent(`${eventType} payload.tool_call_id is invalid`);
      }
      if (
        typeof payload.tool_id !== "string" ||
        !TOOL_ID_PATTERN.test(payload.tool_id)
      ) {
        invalidEvent(`${eventType} payload.tool_id is invalid`);
      }
      return;
    }
    case "tool_result_completed": {
      requireClosedKeys(
        payload,
        ["tool_call_id", "outcome", "result"],
        ["tool_call_id", "outcome", "result"],
        eventType,
      );
      if (
        typeof payload.tool_call_id !== "string" ||
        !ID_PATTERN.test(payload.tool_call_id)
      ) {
        invalidEvent(`${eventType} payload.tool_call_id is invalid`);
      }
      if (payload.outcome !== "success" && payload.outcome !== "failure") {
        invalidEvent(`${eventType} payload.outcome is invalid`);
      }
      if (!isRecord(payload.result)) {
        invalidEvent(`${eventType} payload.result must be an object`);
      }
      return;
    }
    case "attempt_stopped": {
      requireClosedKeys(
        payload,
        ["reason", "error_code", "unresolved_obligation_count"],
        ["reason", "unresolved_obligation_count"],
        eventType,
      );
      if (
        !["cancelled", "hard_deadline", "stop_policy", "failed"].includes(
          String(payload.reason),
        )
      ) {
        invalidEvent(`${eventType} payload.reason is invalid`);
      }
      if (!isNonNegativeInt(payload.unresolved_obligation_count)) {
        invalidEvent(
          `${eventType} payload.unresolved_obligation_count is invalid`,
        );
      }
      if (
        "error_code" in payload &&
        !ATTEMPT_STOPPED_ERROR_CODES.has(String(payload.error_code))
      ) {
        invalidEvent(`${eventType} payload.error_code is invalid`);
      }
      return;
    }
    case "attempt_rollover_ready": {
      requireClosedKeys(
        payload,
        [
          "last_acknowledged_event_index",
          "resume_marker_digest",
          "workspace_tree_digest",
          "workspace_file_count",
          "workspace_total_bytes",
        ],
        [
          "last_acknowledged_event_index",
          "resume_marker_digest",
          "workspace_tree_digest",
          "workspace_file_count",
          "workspace_total_bytes",
        ],
        eventType,
      );
      if (!isPositiveInt(payload.last_acknowledged_event_index)) {
        invalidEvent(
          `${eventType} payload.last_acknowledged_event_index is invalid`,
        );
      }
      if (!DIGEST_PATTERN.test(String(payload.resume_marker_digest ?? ""))) {
        invalidEvent(`${eventType} payload.resume_marker_digest is invalid`);
      }
      if (!DIGEST_PATTERN.test(String(payload.workspace_tree_digest ?? ""))) {
        invalidEvent(`${eventType} payload.workspace_tree_digest is invalid`);
      }
      if (!isNonNegativeInt(payload.workspace_file_count)) {
        invalidEvent(`${eventType} payload.workspace_file_count is invalid`);
      }
      if (!isNonNegativeInt(payload.workspace_total_bytes)) {
        invalidEvent(`${eventType} payload.workspace_total_bytes is invalid`);
      }
      return;
    }
    case "context_compaction": {
      requireClosedKeys(
        payload,
        [
          "snapshot_id",
          "source_from_run_event_index",
          "source_to_run_event_index",
          "source_digest",
          "compacted_context_digest",
        ],
        [
          "snapshot_id",
          "source_from_run_event_index",
          "source_to_run_event_index",
          "source_digest",
          "compacted_context_digest",
        ],
        eventType,
      );
      if (
        typeof payload.snapshot_id !== "string" ||
        !ID_PATTERN.test(payload.snapshot_id)
      ) {
        invalidEvent(`${eventType} payload.snapshot_id is invalid`);
      }
      if (!isPositiveInt(payload.source_from_run_event_index)) {
        invalidEvent(
          `${eventType} payload.source_from_run_event_index is invalid`,
        );
      }
      if (!isPositiveInt(payload.source_to_run_event_index)) {
        invalidEvent(
          `${eventType} payload.source_to_run_event_index is invalid`,
        );
      }
      if (!DIGEST_PATTERN.test(String(payload.source_digest ?? ""))) {
        invalidEvent(`${eventType} payload.source_digest is invalid`);
      }
      if (
        !DIGEST_PATTERN.test(String(payload.compacted_context_digest ?? ""))
      ) {
        invalidEvent(
          `${eventType} payload.compacted_context_digest is invalid`,
        );
      }
      return;
    }
  }
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

  /**
   * Strict, closed validation of a single wire event against RunEventV1.
   * Rejects unknown top-level fields, unknown event_type values, mismatched
   * origin/run_state/needs_reconciliation, and malformed terminal payloads.
   * run_event_index is required to be an integer >= 1 for every event in
   * this demo boundary (server-origin events are always non-null per the
   * contract; runtime-origin events are treated the same way here).
   */
  function validateRunEvent(value: unknown, runId: string): RunEventV1 {
    if (!isRecord(value)) {
      invalidEvent("server returned an invalid run event");
    }
    const keys = Object.keys(value);
    if (
      keys.length !== RUN_EVENT_KEYS.length ||
      !RUN_EVENT_KEYS.every((key) => key in value)
    ) {
      invalidEvent(
        "server run event does not match the closed RunEventV1 field set",
      );
    }
    if (value.contract_version !== "v1") {
      invalidEvent("server run event has an unsupported contract_version");
    }
    if (typeof value.event_id !== "string" || !ID_PATTERN.test(value.event_id)) {
      invalidEvent("server run event has an invalid event_id");
    }
    if (typeof value.run_id !== "string" || !ID_PATTERN.test(value.run_id)) {
      invalidEvent("server run event has an invalid run_id");
    }
    if (value.run_id !== runId) {
      invalidEvent("server event run_id does not match requested run");
    }
    const eventType = value.event_type;
    if (typeof eventType !== "string" || !(eventType in EVENT_SPECS)) {
      invalidEvent("server run event has an unknown event_type");
    }
    const spec = EVENT_SPECS[eventType];
    if (value.origin !== spec.origin) {
      invalidEvent(`server run event origin is invalid for ${eventType}`);
    }
    if (value.run_state !== spec.runState) {
      invalidEvent(`server run event run_state is invalid for ${eventType}`);
    }
    if (value.needs_reconciliation !== spec.needsReconciliation) {
      invalidEvent(
        `server run event needs_reconciliation is invalid for ${eventType}`,
      );
    }
    if (spec.attemptId === "null") {
      if (value.attempt_id !== null) {
        invalidEvent(`server run event attempt_id must be null for ${eventType}`);
      }
    } else if (
      typeof value.attempt_id !== "string" ||
      !ID_PATTERN.test(value.attempt_id)
    ) {
      invalidEvent(`server run event attempt_id is invalid for ${eventType}`);
    }
    if (spec.attemptSequence === "null") {
      if (value.attempt_sequence !== null) {
        invalidEvent(
          `server run event attempt_sequence must be null for ${eventType}`,
        );
      }
    } else if (!isPositiveInt(value.attempt_sequence)) {
      invalidEvent(
        `server run event attempt_sequence is invalid for ${eventType}`,
      );
    }
    if (!isPositiveInt(value.run_event_index)) {
      invalidEvent(
        "server run event run_event_index must be an integer >= 1",
      );
    }
    if (
      typeof value.occurred_at !== "string" ||
      !UTC_TIMESTAMP_PATTERN.test(value.occurred_at)
    ) {
      invalidEvent("server run event occurred_at is not a valid UTC timestamp");
    }
    if (!isRecord(value.payload)) {
      invalidEvent("server run event payload must be an object");
    }
    validatePayload(eventType, spec, value.payload);
    return value as unknown as RunEventV1;
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

  /**
   * Consumes one SSE response. Plain JSON (arrays or otherwise) is never
   * accepted as a success path: only text/event-stream is trusted.
   */
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
    if (!contentType.includes("text/event-stream")) {
      throw new BffAdapterError(
        "BFF_INVALID_RESPONSE",
        "BFF event stream response was not text/event-stream; SSE is required",
      );
    }
    const text = await response.text();
    if (text.length > MAX_SSE_BUFFER_BYTES) {
      throw new BffAdapterError(
        "BFF_INVALID_RESPONSE",
        "BFF event stream response exceeded the maximum buffer size",
      );
    }
    const events: RunEventV1[] = [];
    const seen = seenSet(runId);
    const blocks = text.split(/\n\n+/).filter((block) => block.trim().length > 0);
    if (blocks.length > MAX_SSE_BUFFER_EVENTS) {
      throw new BffAdapterError(
        "BFF_INVALID_RESPONSE",
        "BFF event stream response exceeded the maximum event count",
      );
    }

    let terminalSeen = false;
    for (const block of blocks) {
      const lines = block.split("\n");
      let id: string | undefined;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        // SSE spec: multiple `data:` lines within one event are concatenated
        // with a newline between them, after stripping a single leading space.
        else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
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
      if (terminalSeen) {
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "server sent an event after a terminal run event",
        );
      }
      if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
        terminalSeen = true;
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
    async classifyConversation(input: {
      episodeId: string;
      message: string;
      clientRequestId: string;
      threadId?: string | null;
    }) {
      const closedPrompt = JSON.stringify({
        task: "classify_conversation",
        schema: {
          intent: [
            "status",
            "reason",
            "evidence",
            "next_action",
            "request_action",
            "unsupported",
          ],
          suggestedActionType: [
            "submit_claim",
            "request_reprocessing",
            "correct_and_resubmit",
            "send_documentation",
            null,
          ],
        },
        episodeId: input.episodeId,
        message: input.message,
        instruction:
          "Return ONLY JSON matching the schema. Do not invent citations or mutate state.",
      });

      let threadId = input.threadId ?? null;
      if (!threadId) {
        const thread = await createThread({
          client_request_id: `${input.clientRequestId}:thread`,
        });
        threadId = thread.thread_id;
      }

      const run = await createRun(threadId, {
        client_request_id: input.clientRequestId,
        prompt: closedPrompt,
      });
      activeRunId = run.run_id;
      const events = await consumeEvents(run.run_id);

      const modelEvent = [...events]
        .reverse()
        .find((e) => e.event_type === "model_response_completed");
      if (!modelEvent) {
        const terminal = [...events]
          .reverse()
          .find((e) => TERMINAL_EVENT_TYPES.has(e.event_type));
        if (terminal?.event_type === "run_completed") {
          throw new BffAdapterError(
            "BFF_INVALID_RESPONSE",
            "BFF run_completed is not a conversational classification receipt",
            502,
          );
        }
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "BFF conversation run produced no model_response_completed event",
          502,
        );
      }

      const payload = modelEvent.payload;
      const rawContent =
        typeof payload.assistant_content === "string"
          ? payload.assistant_content
          : isRecord(payload.assistant_message) &&
              typeof payload.assistant_message.content === "string"
            ? payload.assistant_message.content
            : null;
      if (!rawContent) {
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "BFF conversation classifier returned empty assistant content",
          502,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(extractClassifierJsonDocument(rawContent));
      } catch (error) {
        if (error instanceof BffAdapterError) throw error;
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "BFF conversation classifier returned non-JSON content",
          502,
        );
      }
      if (!isRecord(parsed)) {
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "BFF conversation classifier JSON was not an object",
          502,
        );
      }

      // Closed two-field shape only — reject unknowns before enum coercion.
      const classifierKeys = Object.keys(parsed);
      if (
        classifierKeys.length !== 2 ||
        !classifierKeys.includes("intent") ||
        !classifierKeys.includes("suggestedActionType")
      ) {
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "BFF conversation classifier JSON must contain exactly intent and suggestedActionType",
          502,
        );
      }

      const intents = new Set([
        "status",
        "reason",
        "evidence",
        "next_action",
        "request_action",
        "unsupported",
      ]);
      const actions = new Set([
        "submit_claim",
        "request_reprocessing",
        "correct_and_resubmit",
        "send_documentation",
      ]);
      const intent = parsed.intent;
      if (typeof intent !== "string" || !intents.has(intent)) {
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "BFF conversation classifier returned an invalid intent",
          502,
        );
      }
      const suggested = parsed.suggestedActionType;
      if (
        suggested !== null &&
        (typeof suggested !== "string" || !actions.has(suggested))
      ) {
        throw new BffAdapterError(
          "BFF_INVALID_RESPONSE",
          "BFF conversation classifier returned an invalid suggestedActionType",
          502,
        );
      }

      return {
        intent: intent as
          | "status"
          | "reason"
          | "evidence"
          | "next_action"
          | "request_action"
          | "unsupported",
        suggestedActionType:
          suggested === null
            ? null
            : (suggested as
                | "submit_claim"
                | "request_reprocessing"
                | "correct_and_resubmit"
                | "send_documentation"),
        threadId,
        runId: run.run_id,
      };
    },
    async probe() {
      try {
        const response = await send("GET", "v1/readiness");
        if (!response.ok) {
          return {
            available: false,
            error: `BFF readiness failed with ${response.status}`,
          };
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return {
            available: false,
            error: "BFF readiness response was not JSON",
          };
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return {
            available: false,
            error: "BFF readiness response was not valid JSON",
          };
        }
        if (!isRecord(body)) {
          return {
            available: false,
            error: "BFF readiness response had an unexpected shape",
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
          .find((e) => TERMINAL_EVENT_TYPES.has(e.event_type));
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
        if (terminal.event_type === "run_completed") {
          // run_completed proves ONLY that the model finished; it is never
          // proof that a domain connector (PMS/clearinghouse/payer) received
          // or applied the mutation. Callers must treat this as unverified
          // until an independent domain receipt confirms it.
          return {
            outcome: "pending_verification",
            message:
              "BFF run_completed proves model completion only; domain connector receipt is required",
          };
        }
        // run_outcome_unknown, reconciliation_required, run_cancelled.
        return {
          outcome: "pending_verification",
          message: `BFF ${terminal.event_type}; pending verification`,
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
