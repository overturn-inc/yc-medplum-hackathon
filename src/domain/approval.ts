import { createHash } from "node:crypto";
import type { ActionType, ApprovalReceipt, AgentProposal } from "./types";

export function digestPayload(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
}

export function buildApprovalFingerprint(input: {
  actionType: ActionType;
  episodeId: string;
  payloadDigest: string;
  episodeRevision: number;
}): string {
  return digestPayload({
    actionType: input.actionType,
    episodeId: input.episodeId,
    payloadDigest: input.payloadDigest,
    episodeRevision: input.episodeRevision,
  });
}

export function buildIdempotencyKey(input: {
  actionType: ActionType;
  episodeId: string;
  payloadDigest: string;
}): string {
  return `${input.actionType}:${input.episodeId}:${input.payloadDigest}`;
}

export function createApprovalReceipt(input: {
  proposal: AgentProposal;
  decision: "allow_once" | "deny";
  decidedAt: string;
}): ApprovalReceipt {
  const fingerprint = buildApprovalFingerprint({
    actionType: input.proposal.actionType,
    episodeId: input.proposal.episodeId,
    payloadDigest: input.proposal.payloadDigest,
    episodeRevision: input.proposal.episodeRevision,
  });
  const idempotencyKey = buildIdempotencyKey({
    actionType: input.proposal.actionType,
    episodeId: input.proposal.episodeId,
    payloadDigest: input.proposal.payloadDigest,
  });

  return {
    id: `approval-${input.proposal.id}-${input.decision}`,
    proposalId: input.proposal.id,
    episodeId: input.proposal.episodeId,
    actionType: input.proposal.actionType,
    payloadDigest: input.proposal.payloadDigest,
    episodeRevision: input.proposal.episodeRevision,
    decision: input.decision,
    decidedAt: input.decidedAt,
    idempotencyKey,
    fingerprint,
  };
}

export function assertFreshApproval(input: {
  receipt: ApprovalReceipt;
  currentRevision: number;
  expectedFingerprint: string;
}): void {
  if (input.receipt.episodeRevision !== input.currentRevision) {
    const error = new Error("Stale approval: episode revision mismatch");
    (error as Error & { status: number }).status = 409;
    throw error;
  }
  if (input.receipt.fingerprint !== input.expectedFingerprint) {
    const error = new Error("Stale approval: fingerprint mismatch");
    (error as Error & { status: number }).status = 409;
    throw error;
  }
}

export interface ClientApprovalScope {
  proposalId: string;
  episodeId: string;
  actionType: ActionType;
  payloadDigest: string;
  episodeRevision: number;
  fingerprint: string;
}

/** Validate the exact proposal scope the user reviewed before Allow once / Deny. */
export function assertClientApprovalScope(input: {
  proposal: AgentProposal;
  currentRevision: number;
  client: ClientApprovalScope;
}): void {
  const expectedFingerprint = buildApprovalFingerprint({
    actionType: input.proposal.actionType,
    episodeId: input.proposal.episodeId,
    payloadDigest: input.proposal.payloadDigest,
    episodeRevision: input.proposal.episodeRevision,
  });

  const mismatch =
    input.client.proposalId !== input.proposal.id ||
    input.client.episodeId !== input.proposal.episodeId ||
    input.client.actionType !== input.proposal.actionType ||
    input.client.payloadDigest !== input.proposal.payloadDigest ||
    input.client.episodeRevision !== input.proposal.episodeRevision ||
    input.client.episodeRevision !== input.currentRevision ||
    input.client.fingerprint !== expectedFingerprint ||
    input.proposal.episodeRevision !== input.currentRevision;

  if (mismatch) {
    const error = new Error(
      "Stale or tampered approval scope: proposal fingerprint or revision mismatch",
    );
    (error as Error & { status: number }).status = 409;
    throw error;
  }
}

export function proposalApprovalFields(proposal: AgentProposal) {
  const fingerprint = buildApprovalFingerprint({
    actionType: proposal.actionType,
    episodeId: proposal.episodeId,
    payloadDigest: proposal.payloadDigest,
    episodeRevision: proposal.episodeRevision,
  });
  return {
    proposalId: proposal.id,
    actionType: proposal.actionType,
    episodeId: proposal.episodeId,
    payloadDigest: proposal.payloadDigest,
    episodeRevision: proposal.episodeRevision,
    fingerprint,
  };
}
