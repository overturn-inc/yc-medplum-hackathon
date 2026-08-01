/**
 * Server-side conversational agent service. Wraps the session repository and
 * `ActionService`. In synthetic mode, intent is classified locally. In BFF
 * mode, a closed classifier/responder is invoked on the connected agent
 * boundary; domain code always re-renders grounded answers and rebuilds
 * proposals from server policy. Model output never mutates state.
 */
import {
  answerChatMessage,
  answerChatWithIntent,
} from "@/domain/agent-chat";
import { getDemoClock } from "@/domain/clock";
import type {
  AgentIntent,
  ClaimEpisode,
  ConversationMessage,
  DemoSnapshot,
  DomainEvent,
} from "@/domain/types";
import type { AgentAdapter } from "@/adapters/agent/types";
import type {
  RetrievalAdapter,
  RetrievalResult,
} from "@/adapters/retrieval/types";
import { sanitizeBffError } from "@/adapters/agent/bff";
import type { ActionService } from "@/server/actions";
import type { SessionRepository } from "@/server/repository";

export interface ChatInput {
  episodeId: string;
  message: string;
  clientRequestId?: string;
  /** Optional client-known episode revision; guards stale request_action turns. */
  revision?: number;
}

export interface ChatResult {
  snapshot: DemoSnapshot;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  proposalCreated: boolean;
  idempotent: boolean;
  retrieval: RetrievalResult | null;
  retrievalError?: string;
}

function messageId(kind: "user" | "assistant", episodeId: string, at: string): string {
  return `msg-${kind}-${episodeId}-${at}-${Math.random().toString(36).slice(2, 7)}`;
}

export class AgentChatService {
  constructor(
    private readonly store: SessionRepository,
    private readonly actions: ActionService,
    private readonly agent: AgentAdapter | null = null,
    private readonly retrieval: RetrievalAdapter | null = null,
  ) {}

  async handleChat(input: ChatInput): Promise<ChatResult> {
    const episode = await this.store.getEpisode(input.episodeId);
    if (!episode) {
      throw Object.assign(new Error("Episode not found"), { status: 404 });
    }

    if (input.clientRequestId) {
      const idempotent = this.findIdempotentTurn(episode, input.clientRequestId);
      if (idempotent) {
        return {
          snapshot: await this.store.getSnapshot(),
          userMessage: idempotent.userMessage,
          assistantMessage: idempotent.assistantMessage,
          proposalCreated: false,
          idempotent: true,
          retrieval: null,
        };
      }
    }

    const text = input.message.trim();
    if (!text) {
      throw Object.assign(new Error("message is required"), { status: 400 });
    }

    // Intent + pre-action policy only. Final content/citations are rendered
    // later from the durable episode inside the chat mutation lock.
    const answer = await this.resolveAnswer(episode, text, input.clientRequestId);
    let retrieval: RetrievalResult | null = null;
    let retrievalError: string | undefined;
    if (this.retrieval) {
      try {
        retrieval = await this.retrieval.query({
          episodeId: episode.id,
          query:
            `${text}\nSynthetic claim ${episode.claimId}; payer ${episode.payerId}; ` +
            `date of service ${episode.dateOfService}; CPT ${episode.cpt}.`,
          topK: 4,
        });
      } catch {
        // Retrieval augments grounded domain answers. It never blocks a safe
        // read or falls back to unscoped model content when Moss is unavailable.
        retrievalError = "Moss retrieval is temporarily unavailable";
      }
    }

    if (
      answer.intent === "request_action" &&
      answer.suggestedActionType &&
      typeof input.revision === "number" &&
      input.revision !== episode.revision
    ) {
      throw Object.assign(
        new Error("Stale episode revision: reload the episode before requesting an action"),
        { status: 409 },
      );
    }

    let proposalCreated = false;
    let proposalId: string | undefined;
    let actionOutcomeSuffix = "";

    // Keep ActionService outside the chat mutation lock to avoid nested locks.
    // Capture only outcome suffix / proposal id — never stale rendered content.
    if (answer.intent === "request_action" && answer.executeReadOnlyRefresh) {
      try {
        const result = await this.actions.refreshPayerStatus(episode.id);
        actionOutcomeSuffix = ` ${result.message}`;
      } catch (error) {
        actionOutcomeSuffix = ` (Could not refresh payer status: ${
          error instanceof Error ? error.message : "unknown error"
        }.)`;
      }
    } else if (answer.intent === "request_action" && answer.suggestedActionType) {
      try {
        const result = await this.actions.createProposal(
          episode.id,
          answer.suggestedActionType,
        );
        proposalCreated = true;
        proposalId = result.proposal.id;
      } catch (error) {
        actionOutcomeSuffix = ` (Could not create the proposal: ${
          error instanceof Error ? error.message : "unknown error"
        }.)`;
      }
    }

    const userAt = getDemoClock();
    const userMessage: ConversationMessage = {
      id: messageId("user", episode.id, userAt),
      episodeId: episode.id,
      role: "user",
      content: text,
      intent: answer.intent,
      citations: [],
      createdAt: userAt,
      clientRequestId: input.clientRequestId,
    };

    return this.store.withMutationLock(async () => {
      await this.store.beginMutation();
      try {
        const refreshed = await this.store.getEpisode(episode.id);
        if (!refreshed) {
          throw Object.assign(new Error("Episode not found"), { status: 404 });
        }

        if (input.clientRequestId) {
          const idempotent = this.findIdempotentTurn(refreshed, input.clientRequestId);
          if (idempotent) {
            await this.store.abortMutation();
            return {
              snapshot: await this.store.getSnapshot(),
              userMessage: idempotent.userMessage,
              assistantMessage: idempotent.assistantMessage,
              proposalCreated: false,
              idempotent: true,
              retrieval: null,
            };
          }
        }

        const grounded = answerChatWithIntent(refreshed, answer.intent);
        const rankedCitations = this.rankCitations(
          grounded.citations,
          retrieval,
        );
        const assistantAt = getDemoClock();
        const assistantMessage: ConversationMessage = {
          id: messageId("assistant", episode.id, assistantAt),
          episodeId: episode.id,
          role: "assistant",
          content: `${grounded.content}${actionOutcomeSuffix}`.trim(),
          intent: answer.intent,
          citations: rankedCitations,
          createdAt: assistantAt,
          proposalId,
        };

        const withConversation: ClaimEpisode = {
          ...refreshed,
          conversation: [...(refreshed.conversation ?? []), userMessage, assistantMessage],
        };
        this.store.replaceEpisode(withConversation);

        const userEvent: DomainEvent = {
          type: "conversation.message.appended",
          id: `event-conv-${userMessage.id}`,
          at: assistantAt,
          sessionId: this.store.sessionId,
          episodeId: episode.id,
          messageId: userMessage.id,
          role: "user",
          intent: userMessage.intent,
          clientRequestId: input.clientRequestId,
        };
        const assistantEvent: DomainEvent = {
          type: "conversation.message.appended",
          id: `event-conv-${assistantMessage.id}`,
          at: assistantAt,
          sessionId: this.store.sessionId,
          episodeId: episode.id,
          messageId: assistantMessage.id,
          role: "assistant",
          intent: assistantMessage.intent,
        };
        this.store.appendEvent(userEvent);
        this.store.appendEvent(assistantEvent);

        if (this.store.saveConversation) {
          await this.store.saveConversation(
            episode.id,
            withConversation.conversation ?? [],
          );
        }

        const snapshot = await this.store.commit();
        return {
          snapshot,
          userMessage,
          assistantMessage,
          proposalCreated,
          idempotent: false,
          retrieval,
          ...(retrievalError ? { retrievalError } : {}),
        };
      } catch (error) {
        await this.store.abortMutation();
        throw error;
      }
    });
  }

  private async resolveAnswer(
    episode: ClaimEpisode,
    text: string,
    clientRequestId?: string,
  ) {
    if (this.agent?.mode === "bff") {
      if (!this.agent.classifyConversation) {
        throw Object.assign(
          new Error("BFF conversational classifier is not configured"),
          { status: 503 },
        );
      }
      try {
        const existingThread = this.store.getThreadBinding
          ? await this.store.getThreadBinding(episode.id)
          : null;
        const classified = await this.agent.classifyConversation({
          episodeId: episode.id,
          message: text,
          clientRequestId: clientRequestId ?? `chat-${episode.id}-${Date.now()}`,
          threadId: existingThread,
        });
        if (this.store.bindThread) {
          await this.store.bindThread(episode.id, classified.threadId);
        }
        // Domain policy discovery only; final grounded content is rendered
        // from the refreshed durable episode inside the chat mutation lock.
        // BFF may only supply intent.
        return answerChatWithIntent(episode, classified.intent as AgentIntent);
      } catch (error) {
        const sanitized = sanitizeBffError(error);
        throw Object.assign(new Error(sanitized.message), {
          status: sanitized.status || 503,
          code: "BFF_CHAT_FAILED",
        });
      }
    }

    return answerChatMessage(episode, text);
  }

  private findIdempotentTurn(
    episode: ClaimEpisode,
    clientRequestId: string,
  ): { userMessage: ConversationMessage; assistantMessage: ConversationMessage } | null {
    const conversation = episode.conversation ?? [];
    const userIndex = conversation.findIndex(
      (m) => m.role === "user" && m.clientRequestId === clientRequestId,
    );
    if (userIndex < 0) return null;
    const assistantMessage = conversation
      .slice(userIndex + 1)
      .find((m) => m.role === "assistant");
    if (!assistantMessage) return null;
    return { userMessage: conversation[userIndex]!, assistantMessage };
  }

  private rankCitations(
    citations: ConversationMessage["citations"],
    retrieval: RetrievalResult | null,
  ): ConversationMessage["citations"] {
    if (!retrieval?.documents.length) return citations;
    const order = new Map(
      retrieval.documents.map((document, index) => [document.reference, index]),
    );
    return citations
      .map((citation, index) => ({ citation, index }))
      .sort((a, b) => {
        const aRank = order.get(a.citation.reference) ?? Number.MAX_SAFE_INTEGER;
        const bRank = order.get(b.citation.reference) ?? Number.MAX_SAFE_INTEGER;
        return aRank - bRank || a.index - b.index;
      })
      .map(({ citation }) => citation);
  }
}

export function createAgentChatService(
  store: SessionRepository,
  actions: ActionService,
  agent: AgentAdapter | null = null,
  retrieval: RetrievalAdapter | null = null,
): AgentChatService {
  return new AgentChatService(store, actions, agent, retrieval);
}
