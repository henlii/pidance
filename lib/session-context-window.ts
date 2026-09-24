import type { AgentMessage, SessionContext } from "./types";

/** 首屏尾页条数（tail-first）。 */
export const DEFAULT_SESSION_TAIL_LIMIT = 100;
/** 向上滚动时每页更旧消息条数。 */
export const DEFAULT_SESSION_HISTORY_PAGE = 100;

/**
 * 分页边界对齐到「轮」时允许额外向前多取的条数上限（= limit）。
 *
 * 一轮（一条 user 消息到下一个 user 之前）实测 p50 18–98 条、p90 137–542、最大 836：
 * 单纯按「组」分页会让 100 组等于整个会话（实测 5482/7708/5016 条）。所以单位仍是
 * 条数，只把起点对齐到最近的提问 —— 阅读上"每页从提问开始"，成本仍有硬顶。
 */
export const DEFAULT_TURN_ALIGN_MAX_EXTEND = DEFAULT_SESSION_HISTORY_PAGE;

/**
 * 把窗口起点向前对齐到最近的 user 消息（轮开头）。
 * 找不到（或在 maxExtend 内找不到）就返回原下标：宁可切开一轮，也不让单页无限膨胀。
 */
function alignToTurnStart(
  messages: readonly { role?: string }[],
  index: number,
  maxExtend: number,
): number {
  if (index <= 0) return index;
  if (messages[index]?.role === "user") return index;
  const floor = Math.max(0, index - Math.max(0, maxExtend));
  for (let i = index - 1; i >= floor; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return index;
}

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
 * 窗口预算只数「会渲染成独立一行的消息」：user/assistant、压缩与分支摘要、
 * 扩展自定义消息、bash 执行记录都算；toolResult 渲染在所属工具调用内部，
 * 搭车但不算数（同 Pi 原生 TUI 的读法）。
 *
 * 按原始条数计数会让工具密集的会话饿死用户提问：实测 15 条 user 散在
 * 562 条记录里，100 条窗口只覆盖 1 条用户消息，其余都要手点「加载更早」。
 */
export function countsTowardWindow(message: { role?: string }): boolean {
  return message.role !== "toolResult";
}

/** 单页原始条数上界的最小值（工具流里可见消息稀疏时兜底）。 */
export const MIN_RAW_WINDOW_SPAN = 200;

/**
 * 单页原始条数硬上界：可见消息预算的 6 倍。
 * 一段纯工具流里可能夹着极少的可见消息，只按可见预算取窗会让单页 payload
 * 无界膨胀；超出上界时宁可切断一轮。
 */
export function rawWindowSpanCap(budget: number): number {
  const n = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 1;
  return Math.max(MIN_RAW_WINDOW_SPAN, n * 6);
}

/**
 * 从 endExclusive 往前数 budget 条可见消息，返回窗口起点下标（含上界截断）。
 * 可见消息不足 budget 条时回到 0；原始跨度上界先命中时停在边界 —— 此时窗口里
 * 可能一条可见消息都没有（见 ensureVisibleStart）。
 */
function visibleWindowStart(
  messages: readonly { role?: string }[],
  endExclusive: number,
  budget: number,
): number {
  let visible = 0;
  let start = endExclusive;
  while (start > 0 && visible < budget) {
    start--;
    if (countsTowardWindow(messages[start])) visible++;
  }
  return Math.max(start, endExclusive - rawWindowSpanCap(budget));
}

/**
 * 从 startInclusive 往后数 budget 条可见消息，返回窗口终点下标（不含）。
 */
function visibleWindowEnd(
  messages: readonly { role?: string }[],
  startInclusive: number,
  budget: number,
): number {
  let visible = 0;
  let end = startInclusive;
  while (end < messages.length && visible < budget) {
    if (countsTowardWindow(messages[end])) visible++;
    end++;
  }
  return Math.min(end, startInclusive + rawWindowSpanCap(budget));
}

/** 窗口 [from, to) 内是否存在会独立成行的可见消息。 */
function hasVisibleRow(
  messages: readonly { role?: string }[],
  from: number,
  to: number,
): boolean {
  for (let i = from; i < to; i++) {
    const message = messages[i];
    if (message && countsTowardWindow(message)) return true;
  }
  return false;
}

/**
 * 原始跨度上界可能正好切进一段纯 toolResult：这一页没有任何「会渲染成独立一行」的消息
 * （`MessageView` 对单条的 toolResult 返回 null，它们只挂在所属 assistant 的工具卡里），
 * 而 `hasMoreBefore` 仍为 true —— 用户点「加载更早」看不到任何东西。
 *
 * 因此：窗内已经有可见消息时不动作（上界仍是硬顶）；窗内一条都没有时，把起点退到
 * 最近的一条可见消息（通常是这批工具调用的所属 assistant）。退让量等于那段工具流的
 * 长度：这是唯一能把「可读」和「有界」同时满足的选法 —— 没有所属 assistant 的工具记录
 * 在 UI 上根本不渲染。
 */
function ensureVisibleStart(
  messages: readonly { role?: string }[],
  start: number,
  endExclusive: number,
): number {
  if (hasVisibleRow(messages, start, endExclusive)) return start;

  let next = start;
  while (next > 0) {
    next--;
    const message = messages[next];
    if (message && countsTowardWindow(message)) return next;
  }
  return 0;
}

/**
 * 向后找下一条可见消息，返回「包含它」的终点下标（同 ensureVisibleStart，方向相反）。
 * 后面再没有可见消息时返回原终点，由调用方决定怎么收尾。
 */
function ensureVisibleEnd(
  messages: readonly { role?: string }[],
  start: number,
  endExclusive: number,
): number {
  if (hasVisibleRow(messages, start, endExclusive)) return endExclusive;

  for (let next = endExclusive; next < messages.length; next++) {
    const message = messages[next];
    if (message && countsTowardWindow(message)) return next + 1;
  }
  return endExclusive;
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
 * 取 leaf 上下文的尾部窗口（最新 limit 条可见消息）。
 * messages/entryIds 平行切片；model/thinkingLevel 原样保留。
 * toolResult 搭车，不消耗 limit；原始跨度另有硬上界（见 rawWindowSpanCap）。
 */
export function sliceContextTail(
  context: SessionContext,
  limit: number = DEFAULT_SESSION_TAIL_LIMIT,
): SessionContextWindow {
  const totalMessageCount = context.messages.length;
  const n = clampLimit(limit, DEFAULT_SESSION_TAIL_LIMIT);
  const visibleStart = visibleWindowStart(context.messages as { role?: string }[], totalMessageCount, n);
  // 起点对齐到最近的提问；上界仍以原始跨度为硬顶（宁可切断一轮），但整个窗口都是
  // toolResult 时（UI 一条也不渲染）要退到所属 assistant，否则这一页是空的。
  const aligned = alignToTurnStart(context.messages as { role?: string }[], visibleStart, n);
  const start = ensureVisibleStart(
    context.messages as { role?: string }[],
    Math.max(aligned, totalMessageCount - rawWindowSpanCap(n)),
    totalMessageCount,
  );
  return {
    messages: context.messages.slice(start),
    entryIds: context.entryIds.slice(start),
    thinkingLevel: context.thinkingLevel,
    model: context.model,
    hasMoreBefore: start > 0,
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
  const messages = context.messages as { role?: string }[];
  const alignedStart = Math.max(0, alignToTurnStart(messages, Math.max(0, idx - half), half));
  // toEnd：窗口从 anchor 前一小段一直取到最新（跳转历史时把「之后」整段一并带上，
  // 运行中会话的尾部流式输出才不会被切掉）。
  const rawEnd = options.toEnd ? totalMessageCount : Math.min(totalMessageCount, alignedStart + n);
  // 锚点落在一段工具流里时（如搜到某条 toolResult）整页可能没有可见行：先往锚点之前
  // 退到所属 assistant（工具记录归属它前面的 assistant），退不动再往后找出下一条可见消息。
  let start = alignedStart;
  let end = rawEnd;
  if (!hasVisibleRow(messages, start, end)) {
    const backward = ensureVisibleStart(messages, start, end);
    if (backward !== start) start = backward;
    else end = ensureVisibleEnd(messages, start, end);
  }
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
 * 与首页同口径：预算按可见消息计，toolResult 搭车。
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
  const messages = context.messages as { role?: string }[];
  const rawEnd = visibleWindowEnd(messages, idx + 1, n);
  // 不含 after 本身，所以只能往前进。后面确实没有可见行了就把剩余记录一次交完、
  // 结束「还有更新」：空窗口不会推进游标，客户端会反复请求同一段。
  const forward = ensureVisibleEnd(messages, idx + 1, rawEnd);
  const end = forward === rawEnd && !hasVisibleRow(messages, idx + 1, rawEnd) ? totalMessageCount : forward;
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
 * 与首页同口径：预算按可见消息计，toolResult 搭车——否则「加载更早」在
 * 工具密集的会话里只多出几条工具记录，用户看不到新的提问。
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
  const visibleStart = visibleWindowStart(context.messages as { role?: string }[], idx, n);
  const aligned = alignToTurnStart(context.messages as { role?: string }[], visibleStart, n);
  const start = ensureVisibleStart(
    context.messages as { role?: string }[],
    Math.max(aligned, idx - rawWindowSpanCap(n)),
    idx,
  );
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
