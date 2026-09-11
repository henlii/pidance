import type { AgentMessage, SessionContext } from "./types";

/** 首屏尾页条数（OpenChamber 风格 tail-first；偏大一点覆盖 tool 长尾）。 */
export const DEFAULT_SESSION_TAIL_LIMIT = 80;
/** 向上滚动时每页更旧消息条数。 */
export const DEFAULT_SESSION_HISTORY_PAGE = 80;

export type SessionContextWindow = SessionContext & {
  /** 当前窗口之前是否还有更旧消息（leaf 路径上）。 */
  hasMoreBefore: boolean;
  /** 未切片前的消息总数（stats / UI 用）。 */
  totalMessageCount: number;
};

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(Math.floor(limit), 500));
}

/**
 * 解析查询参数中的 limit/tail；缺省返回 null（调用方表示不切片）。
 * `tail` 与 `limit` 同义（兼容两种命名）。
 */
export function parseContextLimitParam(
  searchParams: { get(name: string): string | null },
  fallbackWhenPresent = DEFAULT_SESSION_TAIL_LIMIT,
): number | null {
  const raw = searchParams.get("limit") ?? searchParams.get("tail");
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackWhenPresent;
  return clampLimit(n, fallbackWhenPresent);
}

/**
 * 取 leaf 上下文的尾部窗口（最新 limit 条）。
 * messages/entryIds 平行切片；model/thinkingLevel 原样保留。
 */
export function sliceContextTail(
  context: SessionContext,
  limit: number = DEFAULT_SESSION_TAIL_LIMIT,
): SessionContextWindow {
  const totalMessageCount = context.messages.length;
  const n = clampLimit(limit, DEFAULT_SESSION_TAIL_LIMIT);
  if (totalMessageCount <= n) {
    return {
      ...context,
      hasMoreBefore: false,
      totalMessageCount,
    };
  }
  const start = totalMessageCount - n;
  return {
    messages: context.messages.slice(start),
    entryIds: context.entryIds.slice(start),
    thinkingLevel: context.thinkingLevel,
    model: context.model,
    hasMoreBefore: true,
    totalMessageCount,
  };
}

/**
 * 取 beforeEntryId 之前的更旧窗口（不含 before 本身）。
 * before 不在列表中时返回空窗 + hasMoreBefore=false（调用方可当 400/空处理）。
 */
export function sliceContextBefore(
  context: SessionContext,
  beforeEntryId: string,
  limit: number = DEFAULT_SESSION_HISTORY_PAGE,
): SessionContextWindow {
  const totalMessageCount = context.messages.length;
  const idx = context.entryIds.indexOf(beforeEntryId);
  if (idx <= 0) {
    return {
      messages: [],
      entryIds: [],
      thinkingLevel: context.thinkingLevel,
      model: context.model,
      hasMoreBefore: false,
      totalMessageCount,
    };
  }
  const n = clampLimit(limit, DEFAULT_SESSION_HISTORY_PAGE);
  const start = Math.max(0, idx - n);
  return {
    messages: context.messages.slice(start, idx),
    entryIds: context.entryIds.slice(start, idx),
    thinkingLevel: context.thinkingLevel,
    model: context.model,
    hasMoreBefore: start > 0,
    totalMessageCount,
  };
}
