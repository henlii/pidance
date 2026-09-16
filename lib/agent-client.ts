// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import type { PromptEffectiveAction, PromptReason, PromptReceipt } from "./agent-commands";
import { normalizeFollowUpItemList } from "./session-queue";
import type { AttachedImage, BinaryMessageInput } from "./types";

const PROMPT_RECEIPT_STATUSES: PromptReceipt["status"][] = ["accepted", "queued", "rejected"];
const PROMPT_EFFECTIVE_ACTIONS: PromptEffectiveAction[] = ["prompt", "steer", "queued"];
const PROMPT_REASONS: PromptReason[] = [
  "busy", "compacting", "bash", "media", "locked", "model", "auth", "extension", "error",
];

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: options?.signal,
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.data as T;
}

export async function submitAgentPrompt(
  sessionId: string,
  input: { message: string; images?: AttachedImage[]; binaryBlocks?: BinaryMessageInput[]; submissionId: string },
  options?: { signal?: AbortSignal },
): Promise<PromptReceipt> {
  const data = await sendAgentCommand<unknown>(sessionId, {
    type: "prompt",
    message: input.message,
    submissionId: input.submissionId,
    ...(input.images?.length ? {
      images: input.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
    } : {}),
    ...(input.binaryBlocks?.length ? { binaryBlocks: input.binaryBlocks } : {}),
  }, options);
  if (!data || typeof data !== "object") {
    throw new Error("Invalid prompt receipt: expected an object");
  }
  const receipt = data as {
    submissionId?: unknown;
    sessionId?: unknown;
    status?: unknown;
    action?: unknown;
    reason?: unknown;
    queue?: unknown;
  };
  if (
    typeof receipt.submissionId !== "string"
    || !receipt.submissionId
    || typeof receipt.sessionId !== "string"
    || !receipt.sessionId
    // queued 是合法回执（载荷已被可靠入队）：不接受它会把已持久化的消息报成失败，
    // 用户重发一次就是重复投递。
    || !PROMPT_RECEIPT_STATUSES.includes(receipt.status as PromptReceipt["status"])
  ) {
    throw new Error("Invalid prompt receipt");
  }
  if (receipt.submissionId !== input.submissionId || receipt.sessionId !== sessionId) {
    throw new Error("Invalid prompt receipt");
  }
  return {
    submissionId: receipt.submissionId,
    sessionId: receipt.sessionId,
    status: receipt.status as PromptReceipt["status"],
    ...(PROMPT_EFFECTIVE_ACTIONS.includes(receipt.action as PromptEffectiveAction)
      ? { action: receipt.action as PromptEffectiveAction }
      : {}),
    ...(PROMPT_REASONS.includes(receipt.reason as PromptReason)
      ? { reason: receipt.reason as PromptReason }
      : {}),
    ...(parseReceiptQueue(receipt.queue) ?? {}),
  };
}

/** 回执里的权威队列快照：字段不全就当没有（宁可少一个快照也不要半个错的）。 */
function parseReceiptQueue(
  value: unknown,
): { queue: NonNullable<PromptReceipt["queue"]> } | null {
  if (!value || typeof value !== "object") return null;
  const queue = value as { items?: unknown; revision?: unknown; inFlight?: unknown };
  if (!Array.isArray(queue.items) || typeof queue.revision !== "number") return null;
  const inFlight = Array.isArray(queue.inFlight)
    ? queue.inFlight.filter((text): text is string => typeof text === "string")
    : [];
  return { queue: { items: normalizeFollowUpItemList(queue.items), revision: queue.revision, inFlight } };
}

export function readAgentLiveFlag(data: { live?: unknown; running?: unknown }): boolean {
  if (typeof data.live === "boolean") return data.live;
  return data.running === true;
}
