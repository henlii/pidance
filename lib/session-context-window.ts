import type { AgentMessage, SessionContext } from "./types";

/** 首屏尾页条数（OpenChamber 风格 tail-first；偏大一点覆盖 tool 长尾）。 */
export const DEFAULT_SESSION_TAIL_LIMIT = 80;
/** 向上滚动时每页更旧消息条数。 */
export const DEFAULT_SESSION_HISTORY_PAGE = 80;

export type SessionContextWindow = SessionContext & {
  /** 当前窗口之前是否还有更旧消息（leaf 路径上）。 */
  hasMoreBefore: boolean;
  /** 当前窗口之后是否还有更新消息（按 entryId 定位的中间窗口才有意义）。 */
  hasMoreAfter?: boolean;
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

/** 压缩预留量默认值（与 SDK/settings 默认一致）：声明窗口至少要比占用大这么多才留有余量。 */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;

/**
 * 会话占用是否超过目标模型声明的可用输入余量（窗口 - 压缩预留）。
 *
 * 仅做「声明值」层面的比较：sessionTokens 是估算值，声明窗口也可能高于上游真实限额
 * （实测 cpa/grok-4.6 声明 500000，而 ≈381K 的会话已被上游拒绝），因此未命中不代表安全，
 * 命中才是可靠信号。调用方在文案上必须保留这种不确定性。
 */
export function sessionExceedsModelWindow(
  sessionTokens: number | null | undefined,
  contextWindow: number | null | undefined,
  reserveTokens: number = DEFAULT_COMPACTION_RESERVE_TOKENS,
): boolean {
  if (typeof sessionTokens !== "number" || !Number.isFinite(sessionTokens) || sessionTokens <= 0) return false;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  const reserve = Number.isFinite(reserveTokens) && reserveTokens > 0 ? reserveTokens : 0;
  return sessionTokens > contextWindow - reserve;
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
      hasMoreAfter: false,
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
    hasMoreAfter: false,
    totalMessageCount,
  };
}

/**
 * 取 aroundEntryId 附近的窗口（含该条本身）：前后各 limit/2 条。
 *
 * 用于「按 entryId 直接跳转到历史某条」——懒加载分页下逐页翻页成本过高
 * （实测 1343 条消息要翻很多页），服务端一次定位即可。
 * 前后游标都由窗口自身起止决定（不能用 totalMessageCount 推断，否则位于历史开头
 * 也会一直「还有更早」），因此导航定位后仍可继续向上/向下加载。
 *
 * around 不在当前 leaf 路径上时返回 null（显式未命中）：由调用方决定如何提示，
 * 不能静默回退尾页并当成命中。
 */
export function sliceContextAround(
  context: SessionContext,
  aroundEntryId: string,
  limit: number = DEFAULT_SESSION_HISTORY_PAGE,
  options: { toEnd?: boolean } = {},
): SessionContextWindow | null {
  const totalMessageCount = context.messages.length;
  const idx = context.entryIds.indexOf(aroundEntryId);
  if (idx < 0) return null;
  const n = clampLimit(limit, DEFAULT_SESSION_HISTORY_PAGE);
  const half = Math.max(1, Math.floor(n / 2));
  const start = Math.max(0, idx - half);
  // toEnd：窗口从 anchor 前一小段一直取到最新（跳转历史时把「之后」整段一并带上，
  // 运行中会话的尾部流式输出才不会被切掉）。
  const end = options.toEnd ? totalMessageCount : Math.min(totalMessageCount, start + n);
  return {
    messages: context.messages.slice(start, end),
    entryIds: context.entryIds.slice(start, end),
    thinkingLevel: context.thinkingLevel,
    model: context.model,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < totalMessageCount,
    totalMessageCount,
  };
}

/**
 * 取 afterEntryId 之后的更新窗口（不含 after 本身）。
 * 与 sliceContextBefore 对称，供「定位到历史后继续向下加载」使用。
 */
export function sliceContextAfter(
  context: SessionContext,
  afterEntryId: string,
  limit: number = DEFAULT_SESSION_HISTORY_PAGE,
): SessionContextWindow {
  const totalMessageCount = context.messages.length;
  const idx = context.entryIds.indexOf(afterEntryId);
  if (idx < 0 || idx >= totalMessageCount - 1) {
    return {
      messages: [],
      entryIds: [],
      thinkingLevel: context.thinkingLevel,
      model: context.model,
      hasMoreBefore: true,
      hasMoreAfter: false,
      totalMessageCount,
    };
  }
  const n = clampLimit(limit, DEFAULT_SESSION_HISTORY_PAGE);
  const end = Math.min(totalMessageCount, idx + 1 + n);
  return {
    messages: context.messages.slice(idx + 1, end),
    entryIds: context.entryIds.slice(idx + 1, end),
    thinkingLevel: context.thinkingLevel,
    model: context.model,
    hasMoreBefore: true,
    hasMoreAfter: end < totalMessageCount,
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
      hasMoreAfter: false,
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
    hasMoreAfter: true,
    totalMessageCount,
  };
}
