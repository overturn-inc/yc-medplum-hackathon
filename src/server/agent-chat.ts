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
}

function messageId(kind: "user" | "assistant", episodeId: string, at: string): string {
  return `msg-${kind}-${episodeId}-${at}-${Math.random().toString(36).slice(2, 7)}`;
}

export class AgentChatService {
  constructor(
    private readonly store: SessionRepository,
    private readonly actions: ActionService,
    private readonly agent: AgentAdapter | null = null,
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
        };
      }
    }

    const text = input.message.trim();
    if (!text) {
      throw Object.assign(new Error("message is required"), { status: 400 });
    }

    const answer = await this.resolveAnswer(episode, text, input.clientRequestId);

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

    let proposalCreated = false;
    let proposalId: string | undefined;
    let assistantContent = answer.content;
    let latestEpisode: ClaimEpisode = episode;

    if (answer.intent === "request_action" && answer.executeReadOnlyRefresh) {
      try {
        const result = await this.actions.refreshPayerStatus(episode.id);
        const fromSnapshot = result.snapshot.episodes.find((e) => e.id === episode.id);
        if (fromSnapshot) latestEpisode = fromSnapshot;
        assistantContent = `${assistantContent} ${result.message}`.trim();
      } catch (error) {
        assistantContent = `${assistantContent} (Could not refresh payer status: ${
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
        const fromSnapshot = result.snapshot.episodes.find((e) => e.id === episode.id);
        if (fromSnapshot) latestEpisode = fromSnapshot;
      } catch (error) {
        assistantContent = `${assistantContent} (Could not create the proposal: ${
          error instanceof Error ? error.message : "unknown error"
        }.)`;
      }
    }

    const assistantAt = getDemoClock();
    const assistantMessage: ConversationMessage = {
      id: messageId("assistant", episode.id, assistantAt),
      episodeId: episode.id,
      role: "assistant",
      content: assistantContent,
      intent: answer.intent,
      citations: answer.citations,
      createdAt: assistantAt,
      proposalId,
    };

    return this.store.withMutationLock(async () => {
      await this.store.beginMutation();
      try {
        const refreshed = (await this.store.getEpisode(episode.id)) ?? latestEpisode;
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
        return { snapshot, userMessage, assistantMessage, proposalCreated, idempotent: false };
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
        // Domain re-renders grounded content; BFF may only supply intent.
        const grounded = answerChatWithIntent(
          episode,
          classified.intent as AgentIntent,
        );
        // Prefer server policy action for the fixture over model suggestion.
        return grounded;
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
}

export function createAgentChatService(
  store: SessionRepository,
  actions: ActionService,
  agent: AgentAdapter | null = null,
): AgentChatService {
  return new AgentChatService(store, actions, agent);
}
