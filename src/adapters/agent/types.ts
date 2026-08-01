import type { ActionType, AgentIntent } from "@/domain/types";
import type { ProposableActionType } from "@/domain/action-types";

export interface AgentExecuteInput {
  actionType: ActionType;
  episodeId: string;
  idempotencyKey: string;
  payloadDigest: string;
}

export interface AgentExecuteResult {
  outcome: "success" | "pending_verification" | "failed";
  message: string;
  receiptId?: string;
}

export interface AgentStreamEvent {
  id: string;
  cursor: string;
  kind: string;
  payload: unknown;
}

/** Closed conversational classifier output — never treated as domain mutation. */
export interface ConversationClassifyResult {
  intent: AgentIntent;
  suggestedActionType: ProposableActionType | null;
  threadId: string;
  runId: string;
}

export interface ConversationClassifyInput {
  episodeId: string;
  message: string;
  clientRequestId: string;
  threadId?: string | null;
}

export interface AgentAdapter {
  mode: "synthetic" | "bff";
  executeApprovedAction(input: AgentExecuteInput): Promise<AgentExecuteResult>;
  listEvents(cursor?: string): Promise<AgentStreamEvent[]>;
  /** Optional connectivity probe for connected modes. */
  probe?(): Promise<{ available: boolean; error?: string }>;
  /**
   * Optional BFF conversational classifier. Returns a closed intent/action
   * schema only; callers must ground answers and rebuild proposals server-side.
   */
  classifyConversation?(
    input: ConversationClassifyInput,
  ): Promise<ConversationClassifyResult>;
}
