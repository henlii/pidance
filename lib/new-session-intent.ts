/**
 * 新会话客户端意图：只建立 intent，不调用 /api/agent/new。
 * 真实 session id 仅来自 Pi ensure 响应。
 */

export type NewSessionIntent = {
  /** 客户端稳定 id（防旧 ensure/onSessionCreated 污染）。 */
  id: string;
  /** 创建时捕获的目标 cwd；ensure body 必须用此值。 */
  cwd: string;
  /** 单调代际，可选；id 已足够区分。 */
  generation: number;
};

export function createNewSessionIntent(
  cwd: string,
  generation: number,
  makeId: () => string = defaultIntentId,
): NewSessionIntent {
  return {
    id: makeId(),
    cwd,
    generation,
  };
}

export const PENDING_SESSION_ID_PREFIX = "pending:";

export function pendingSessionId(intentId: string): string {
  return `${PENDING_SESSION_ID_PREFIX}${intentId}`;
}

export function isPendingSessionId(id: string): boolean {
  return id.startsWith(PENDING_SESSION_ID_PREFIX);
}

function defaultIntentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 迟到的 onSessionCreated 是否应 promote 当前 chat：
 * - 必须仍是「新会话」态（无 selected 或 selected 已是同一 sid）
 * - intentId 必须匹配当前 intent（若双方均提供）
 */
export function shouldPromoteSessionCreated(input: {
  currentIntentId: string | null | undefined;
  eventIntentId: string | null | undefined;
  selectedSessionId: string | null | undefined;
  createdSessionId: string;
}): boolean {
  const { currentIntentId, eventIntentId, selectedSessionId, createdSessionId } = input;
  if (selectedSessionId && selectedSessionId !== createdSessionId) {
    return false;
  }
  if (currentIntentId && eventIntentId && currentIntentId !== eventIntentId) {
    return false;
  }
  // 有 current intent 但事件无 intentId：拒绝（防旧回调）
  if (currentIntentId && !eventIntentId) {
    return false;
  }
  return true;
}

/**
 * 精确补水结果是否可写回当前 selected chat。
 */
export function shouldApplyHydratedSession(input: {
  selectedSessionId: string | null | undefined;
  hydratedId: string;
  intentId?: string | null;
  activeIntentId?: string | null;
}): boolean {
  if (input.selectedSessionId !== input.hydratedId) return false;
  if (input.activeIntentId && input.intentId && input.activeIntentId !== input.intentId) {
    return false;
  }
  return true;
}
