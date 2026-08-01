import type { ActionType } from "@/domain/types";

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

export interface AgentAdapter {
  mode: "synthetic" | "bff";
  executeApprovedAction(input: AgentExecuteInput): Promise<AgentExecuteResult>;
  listEvents(cursor?: string): Promise<AgentStreamEvent[]>;
  /** Optional connectivity probe for connected modes. */
  probe?(): Promise<{ available: boolean; error?: string }>;
}
