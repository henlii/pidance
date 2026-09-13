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
}): string | null {
  const { outline, loadedEntryIds, topVisibleEntryId, isAtLiveTail } = input;
  if (outline.length === 0 || loadedEntryIds.length === 0) return null;
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
