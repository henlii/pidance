// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import type { PromptReceipt } from "./agent-commands";
import type { AttachedImage } from "./types";

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
  input: { message: string; images?: AttachedImage[]; submissionId: string },
  options?: { signal?: AbortSignal },
): Promise<PromptReceipt> {
  const data = await sendAgentCommand<unknown>(sessionId, {
    type: "prompt",
    message: input.message,
    submissionId: input.submissionId,
    ...(input.images?.length ? {
      images: input.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
    } : {}),
  }, options);
  if (!data || typeof data !== "object") {
    throw new Error("Invalid prompt receipt: expected an object");
  }
  const receipt = data as { submissionId?: unknown; sessionId?: unknown; status?: unknown };
  if (
    typeof receipt.submissionId !== "string"
    || !receipt.submissionId
    || typeof receipt.sessionId !== "string"
    || !receipt.sessionId
    || (receipt.status !== "accepted" && receipt.status !== "rejected")
  ) {
    throw new Error("Invalid prompt receipt");
  }
  if (receipt.submissionId !== input.submissionId || receipt.sessionId !== sessionId) {
    throw new Error("Invalid prompt receipt");
  }
  return {
    submissionId: receipt.submissionId,
    sessionId: receipt.sessionId,
    status: receipt.status,
  };
}

export function readAgentLiveFlag(data: { live?: unknown; running?: unknown }): boolean {
  if (typeof data.live === "boolean") return data.live;
  return data.running === true;
}
