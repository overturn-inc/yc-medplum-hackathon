import type { AgentAdapter, AgentExecuteInput, AgentExecuteResult, AgentStreamEvent } from "./types";

export function createSyntheticAgentAdapter(options?: {
  outcome?: AgentExecuteResult["outcome"];
}): AgentAdapter {
  const events: AgentStreamEvent[] = [];
  let seq = 0;
  const forced = options?.outcome ?? "success";

  return {
    mode: "synthetic",
    async executeApprovedAction(input: AgentExecuteInput): Promise<AgentExecuteResult> {
      seq += 1;
      const receiptId = `synthetic-receipt-${input.actionType}-${input.episodeId}`;
      events.push({
        id: `agent-event-${seq}`,
        cursor: String(seq),
        kind: "action.executed",
        payload: { ...input, receiptId, synthetic: true, outcome: forced },
      });
      if (forced === "failed") {
        return {
          outcome: "failed",
          message: `Synthetic agent failed ${input.actionType}`,
        };
      }
      if (forced === "pending_verification") {
        return {
          outcome: "pending_verification",
          message: `Synthetic agent outcome unknown for ${input.actionType}; pending verification`,
        };
      }
      return {
        outcome: "success",
        message: `Synthetic agent executed ${input.actionType}`,
        receiptId,
      };
    },
    async listEvents(cursor?: string): Promise<AgentStreamEvent[]> {
      if (!cursor) return [...events];
      return events.filter((e) => Number(e.cursor) > Number(cursor));
    },
    async probe() {
      return { available: true };
    },
  };
}
