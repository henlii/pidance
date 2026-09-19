/**
 * 会话用户消息大纲：把一条会话的全部用户消息（提问）抽成轻量列表，供左侧导航条使用。
 *
 * 为什么需要它：会话消息是懒加载的（首屏只取尾部一页），DOM 里只有已加载的那几条，
 * 导航条若只看 DOM 就只列得出这几条。要「列出所有用户消息」，必须直接读完整 entry
 * 列表（服务端只读 JSONL / live 内存视图，不唤醒 writer），再按 entryId 定位与跳转。
 *
 * 纯函数、无 IO：服务端 route 与单测共用。
 */

/**
 * 会话 entry 的最小形状（只用到大纲需要的字段）。
 * 不要求 index signature：调用方直接传 SessionEntry（判别联合）也能赋值。
 */
export interface OutlineEntry {
  id?: string;
  type?: string;
  message?: { role?: string; content?: unknown; timestamp?: number };
}

export interface UserMessageOutlineItem {
  /** Pi entry id：点击跳转与去重都用它 */
  entryId: string;
  /** 该用户消息在大纲中的序号（0 起） */
  ordinal: number;
  /** 纯文本（已去掉非文本块），用于悬浮信息卡与 aria-label */
  text: string;
  /** 落盘时间戳（毫秒；缺失为 undefined） */
  timestamp?: number;
}

/** 用户消息纯文本：字符串或 text 块拼接（与渲染层同一取值语义）。 */
export function entryUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string }[])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}

/**
 * 抽取用户消息大纲。
 * - 只取 `type: "message"` 且 `message.role === "user"` 的 entry；
 * - 缺 id 的 entry 跳过（无法定位，列出来也点不动）；
 * - 顺序保持 entry 顺序（即会话时间顺序）。
 *
 * 注意：调用方传入的必须是**当前 leaf 路径**上的 entries（buildSessionContext 同口径），
 * 否则会把其它分支的提问列出来 —— 那些条 around 定位不到，点不动。
 */
export function buildUserMessageOutline(entries: readonly OutlineEntry[]): UserMessageOutlineItem[] {
  const out: UserMessageOutlineItem[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "user") continue;
    const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
    if (!entryId) continue;
    out.push({
      entryId,
      ordinal: out.length,
      text: entryUserText(message.content),
      ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    });
  }
  return out;
}

/**
 * 已加载窗口里最后一条用户消息的 entryId（无则 null）。
 *
 * 为什么不能用 `messages.length` 当刷新键：乐观用户气泡先用本地 id 显示，
 * 落盘后条数不变但 entryId 换了 —— 只绑长度就永远不会重新拉大纲，
 * 导航条便一直指着旧的那条（「有时不跳到最后一格」的成因之一）。
 */
export function lastUserEntryId(
  messages: readonly { role?: string }[],
  entryIds: readonly string[],
): string | null {
  for (let i = Math.min(messages.length, entryIds.length) - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    const id = entryIds[i];
    if (id) return id;
  }
  return null;
}

/**
 * 把「已加载且是用户消息」的窗口条目抽成大纲种子。
 *
 * 服务端大纲是异步的：新提问落盘前 / 请求在途时，导航条只能靠窗口里的这些条目
 * 先把最后一格画出来，否则末项要等下一次 fetch 才出现。
 */
export function loadedUserOutlineSeeds(
  messages: readonly { role?: string; content?: unknown; timestamp?: number }[],
  entryIds: readonly string[],
): UserMessageOutlineItem[] {
  const seeds: UserMessageOutlineItem[] = [];
  const count = Math.min(messages.length, entryIds.length);
  for (let i = 0; i < count; i += 1) {
    const message = messages[i];
    const entryId = entryIds[i];
    if (message?.role !== "user" || !entryId) continue;
    seeds.push({
      entryId,
      ordinal: seeds.length,
      text: entryUserText(message.content),
      ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    });
  }
  return seeds;
}

/**
 * 把窗口里「大纲还没有、且紧跟在最后一条已知提问之后」的提问补到末尾。
 *
 * 只接尾部连续段：窗口可能是更早的一页（定位历史中间），那时缺的中间项若接到末尾
 * 就会冒充「最后一条提问」，高亮与居中都会跑偏。
 */
export function extendOutlineWithLoadedUsers(input: {
  outline: readonly UserMessageOutlineItem[];
  loadedUsers: readonly UserMessageOutlineItem[];
  /** 当前窗口是否就是最新一段（后面没有更新历史） */
  isAtLiveTail: boolean;
}): UserMessageOutlineItem[] {
  const { outline, loadedUsers, isAtLiveTail } = input;
  // 定位到历史中间时没法判定顺序：窗口后面的更新提问不在窗口里，
  // 把窗口里的未知项接到末尾会冒充「最后一条提问」。
  if (!isAtLiveTail) return outline.slice();
  if (loadedUsers.length === 0) return outline.slice();
  const known = new Set(outline.map((item) => item.entryId));
  const seeds = loadedUsers.filter((item) => item.entryId);
  if (outline.length === 0) {
    return seeds.map((item, index) => ({ ...item, ordinal: index }));
  }
  // 窗口里最后一条「大纲已知」之后的都是更新且尚未进大纲的提问；
  // 一条都不在窗口里（大纲整体成旧）时，窗口里的提问全都更新。
  let tailStart = -1;
  for (let i = seeds.length - 1; i >= 0; i -= 1) {
    if (known.has(seeds[i].entryId)) {
      tailStart = i;
      break;
    }
  }
  const tail = (tailStart >= 0 ? seeds.slice(tailStart + 1) : seeds)
    .filter((item) => !known.has(item.entryId));
  if (tail.length === 0) return outline.slice();
  return [
    ...outline,
    ...tail.map((item, index) => ({ ...item, ordinal: outline.length + index })),
  ];
}

/**
 * 取出属于当前会话的大纲。
 *
 * 大纲是异步到达的，切会话后旧响应或旧 state 若被沿用，导航条会按上一会话的提问
 * 末项去滚动 —— 表现为「停在倒数第几格」。owner 对不上就返回空，让新会话从零开始。
 */
export function outlineForSession(input: {
  sessionId: string | null;
  ownerId: string | null;
  items: readonly UserMessageOutlineItem[];
}): UserMessageOutlineItem[] {
  const { sessionId, ownerId, items } = input;
  if (!sessionId || sessionId !== ownerId) return [];
  return items.slice();
}

/**
 * 解析「当前所在提问」的 entryId。
 *
 * 不能只看已渲染的用户消息元素：渲染窗口只渲染末尾若干条计划项，长会话里大多数
 * 提问（甚至当前视口所在的那条）可能都没被渲染（实测某会话 10 条提问只渲染了 2 条）。
 * 因此改用「视口内最靠上的已渲染消息」在已加载窗口中的位置来推导：
 * 取大纲中「在该位置之前、且属于已加载窗口」的最后一条提问。
 *
 * @param topVisibleEntryId 视口内最靠上的已渲染消息 entryId（没有则 null）
 * @returns 命中的 entryId；无法判定（窗口内没有提问）返回 null，由调用方保持原值
 */
export function resolveActiveOutlineEntry(input: {
  outline: readonly UserMessageOutlineItem[];
  loadedEntryIds: readonly string[];
  topVisibleEntryId: string | null;
  /**
   * 当前窗口是否就是「最新的一段」（后面没有更新的历史）。
   * 尾页窗口可能整段都在某条提问之后（长过程动辄上百条），窗口里一条提问都没有：
   * 此时当前所在提问就是大纲最后一条 —— 只有尾部窗口能这么推，定位到历史中间时
   * 无法判断窗口之前是哪条，返回 null 由调用方保持原高亮。
   */
  isAtLiveTail: boolean;
  /**
   * 滚动容器是否已贴底（“真实底部”区域，与回到底部/恢复跟随同一口径）。
   *
   * 贴底时**当前提问就是最后一条**：末轮很短时视口顶部会落在更早的轮次里，
   * 只按「视口顶部之前最后一条」推会得到上一条提问 —— 导航条于是停在倒数第二格
   * （用户报的「有时候不跳到最后一格」，随末轮长短时好时坏）。
   * 只有窗口就在最新一段时这么推：定位到历史中间时贴的是旧页底部，不是会话末尾。
   */
  isAtScrollBottom?: boolean;
}): string | null {
  const { outline, loadedEntryIds, topVisibleEntryId, isAtLiveTail, isAtScrollBottom = false } = input;
  if (outline.length === 0) return null;
  if (isAtScrollBottom && isAtLiveTail) return outline[outline.length - 1].entryId;
  if (loadedEntryIds.length === 0) return null;
  const loadedIndexById = new Map<string, number>();
  loadedEntryIds.forEach((id, index) => {
    if (id && !loadedIndexById.has(id)) loadedIndexById.set(id, index);
  });
  // 视口顶部在已加载窗口中的位置；没有可用锚点时按窗口起点处理
  const anchorIndex = topVisibleEntryId !== null && loadedIndexById.has(topVisibleEntryId)
    ? loadedIndexById.get(topVisibleEntryId)!
    : 0;
  let active: string | null = null;
  let firstInWindow: string | null = null;
  for (const item of outline) {
    const index = loadedIndexById.get(item.entryId);
    if (index === undefined) continue;
    if (firstInWindow === null) firstInWindow = item.entryId;
    if (index > anchorIndex) break;   // 已到视口顶部之后：上一条即当前所在提问
    active = item.entryId;
  }
  // 视口在窗口第一条提问之前（例如刚定位到窗口更前面）：回退到窗口内第一条提问
  if (active !== null) return active;
  if (firstInWindow !== null) return firstInWindow;
  // 窗口内没有提问且窗口就在最新一段：当前所在提问即大纲最后一条
  return isAtLiveTail ? outline[outline.length - 1].entryId : null;
}
