import { validRenderedLines } from "./custom-rendered-lines";
import type { AgentMessage } from "./types";

/**
 * Pidance 浏览器侧会话时间线的纯变换。
 *
 * 唯一 owner 是 `BrowserSessionRuntimeRegistry`；本模块无状态、无副作用。
 *
 * 每条记录带稳定 `key` 与显式 `pending`：
 * - `key`：磁盘条目用 Pi `entryId`，本地乐观消息用 registry 生成的一次性 id。
 *   绑定与回滚一律走 key，不依赖数组下标，也不依赖正文文本。
 * - `pending`：是否**尚无任何交付证据**的乐观记录。只有 pending 记录参与
 *   「同文本」兼容匹配，避免把已确认的两条同文真实消息合并。
 */
export type TimelineRecord = {
  key: string;
  message: AgentMessage;
  /** Pi JSONL entry id；未确认时为 ""。 */
  entryId: string;
  /** true = 本地乐观，尚未被服务端事件或磁盘快照证实。 */
  pending: boolean;
  /**
   * 这条本地乐观 user 消息是在「本步还在流式输出」时发出的（引导）。
   *
   * Pi 把引导投递到**下一个 step 边界**：磁盘上该引导排在被打断那一步的内容之后。
   * 而浏览器侧乐观气泡在发出当刻就追加到时间线末尾，本步记录（message_end）随后才到
   * ——如果直接追加，引导会被翻到整组上方（用户实测：引导气泡先在下、落盘后跳到上面）。
   * 所以本步记录落盘时要插到这类待确认记录前面，见 insertRecordBeforePendingSteers。
   */
  duringStreamingStep?: boolean;
};

export type Timeline = readonly TimelineRecord[];

/**
 * 从 content 提取纯文本（string 或 blocks 数组两种形状）。
 * Pi 投递的 message_end user content 是 blocks 数组，而乐观气泡是 string；
 * 文本兜底比对必须统一两种形状，否则比对失败会导致双条。
 */
export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

/** 乐观 user 消息的稳定 key：submissionId → key，与数组下标无关。 */
export function submissionKey(submissionId: string): string {
  return `sub:${submissionId}`;
}

/** 把 entryId 同时写到 message 对象上（历史消费者同时读 `messages[i].entryId`）。 */
function stampEntryId(message: AgentMessage, entryId: string): AgentMessage {
  const raw = message as unknown as Record<string, unknown>;
  if (raw.entryId === entryId) return message;
  return { ...raw, entryId } as unknown as AgentMessage;
}

function diskRecord(message: AgentMessage, entryId: string, index: number): TimelineRecord {
  return { key: entryId || `disk:${index}`, message, entryId, pending: false };
}

/** 本地乐观记录（尚未收到任何交付证据）。 */
export function optimisticRecord(key: string, message: AgentMessage): TimelineRecord {
  return { key, message, entryId: "", pending: true };
}

/** 磁盘快照 → 时间线（整体替换语义）。 */
export function timelineFromDisk(messages: readonly AgentMessage[], entryIds: readonly string[]): TimelineRecord[] {
  return messages.map((message, index) => diskRecord(message, entryIds[index] ?? "", index));
}

export function timelineMessages(timeline: Timeline): AgentMessage[] {
  return timeline.map((record) => record.message);
}

export function timelineEntryIds(timeline: Timeline): string[] {
  return timeline.map((record) => record.entryId);
}

export function findRecord(timeline: Timeline, key: string): TimelineRecord | undefined {
  return timeline.find((record) => record.key === key);
}

export function appendRecord(timeline: Timeline, record: TimelineRecord): TimelineRecord[] {
  return [...timeline, record];
}

/**
 * 追加一条已落盘的 step 记录，但要插在「本步流式期间发出的待确认引导」之前。
 *
 * 场景：用户在第 N 步还在输出时插话。乐观气泡已在时间线末尾，第 N 步的
 * assistant 记录随后到达 —— 它属于上面那一组，必须排在引导之前；否则引导气泡
 * 会从「组下方」跳到「组上方」（磁盘上的顺序也是 step 内容在前）。
 * 只跳过**尾部连续**的这类记录：中间隔了别的已落盘消息就不动（那是普通新回合）。
 */
export function insertRecordBeforePendingSteers(
  timeline: Timeline,
  record: TimelineRecord,
): TimelineRecord[] {
  let index = timeline.length;
  while (index > 0) {
    const previous = timeline[index - 1];
    if (!previous.pending || previous.duringStreamingStep !== true) break;
    index -= 1;
  }
  if (index === timeline.length) return [...timeline, record];
  return [...timeline.slice(0, index), record, ...timeline.slice(index)];
}

/** 按 key 就地替换；key 不存在时返回 null（调用方决定回退策略）。 */
export function replaceRecord(
  timeline: Timeline,
  key: string,
  message: AgentMessage,
  entryId?: string,
): TimelineRecord[] | null {
  const index = timeline.findIndex((record) => record.key === key);
  if (index < 0) return null;
  const next = [...timeline];
  next[index] = {
    ...next[index],
    message,
    entryId: entryId || next[index].entryId,
    pending: false,
  };
  return next;
}

/**
 * 删除**尚无交付证据**的乐观记录。
 * 已确认（pending=false）或已带 entryId 的记录不得删除：服务端已观察到这条消息，
 * 迟到的 HTTP 错误不能把它抹掉。
 */
export function dropPendingRecord(
  timeline: Timeline,
  key: string,
): { timeline: TimelineRecord[]; dropped: boolean } {
  const index = timeline.findIndex((record) => record.key === key);
  if (index < 0) return { timeline: [...timeline], dropped: false };
  const record = timeline[index];
  if (!record.pending || record.entryId) return { timeline: [...timeline], dropped: false };
  const next = [...timeline];
  next.splice(index, 1);
  return { timeline: next, dropped: true };
}

/** 删除所有仍无交付证据的乐观记录；返回是否删掉了任何一条。 */
export function dropAllPendingRecords(
  timeline: Timeline,
): { timeline: TimelineRecord[]; dropped: boolean } {
  const next = timeline.filter((record) => !(record.pending && !record.entryId));
  return { timeline: next, dropped: next.length !== timeline.length };
}

/**
 * prepend 更旧页：按 entryId 去重（边界重叠时保留已有较新侧）。
 * 未确认的乐观记录只在末尾，不受影响。
 */
export function prependOlderRecords(
  timeline: Timeline,
  olderMessages: readonly AgentMessage[],
  olderEntryIds: readonly string[],
): TimelineRecord[] {
  const existing = new Set(timeline.map((record) => record.entryId).filter(Boolean));
  const older: TimelineRecord[] = [];
  for (let index = 0; index < olderEntryIds.length; index++) {
    const entryId = olderEntryIds[index] ?? "";
    if (entryId && existing.has(entryId)) continue;
    older.push(diskRecord(olderMessages[index], entryId, index));
  }
  return older.length === 0 ? [...timeline] : [...older, ...timeline];
}

/**
 * 磁盘尾页是否只是「时间线已知内容的旧快照」（读落后，不是新内容）。
 *
 * 判据：这一页的每个 entryId 都已在时间线里，且页尾不是时间线最后一条已确认记录。
 * 说明时间线还有比这次磁盘读更新的记录 —— 磁盘读发生在写入落盘之前（同会话 tail
 * 再拉的典型竞态：agent_end/切回前台触发的 reload 早于最后一笔 append 可见）。
 * 这种页只能用来补齐更旧的历史，绝不能用它缩短时间线，否则界面会倒退到旧内容，
 * 只有整页刷新（冷加载）才恢复。
 */
export function isTailPageBehind(
  timelineEntryIds: readonly string[],
  pageEntryIds: readonly string[],
): boolean {
  const pageIds = pageEntryIds.filter(Boolean);
  if (pageIds.length === 0) return false;
  const known = new Set(timelineEntryIds.filter(Boolean));
  if (!pageIds.every((entryId) => known.has(entryId))) return false;
  const lastKnown = [...timelineEntryIds].reverse().find(Boolean) ?? null;
  const pageLast = pageIds[pageIds.length - 1];
  return lastKnown !== null && pageLast !== lastKnown;
}

/**
 * 尾页重载合并：保留本地已加载、且不在新尾页中的更旧前缀；
 * 用新尾页替换重叠段及之后（含新产生的消息）。
 * 用于 agent_end reload / 同会话 tail 再拉，避免丢掉已 prepend 的历史。
 *
 * 例外：磁盘读落后于时间线（见 isTailPageBehind）时保持时间线不动 ——
 * 「刷新」不得让已经显示出来的内容倒退，只有冷加载/明确导航才能缩短它。
 */
export function mergeTailRecords(
  timeline: Timeline,
  nextMessages: readonly AgentMessage[],
  nextEntryIds: readonly string[],
): TimelineRecord[] {
  if (nextEntryIds.length === 0) return [...timeline];
  const next = timelineFromDisk(nextMessages, nextEntryIds);
  const previousEntryIds = timeline.map((record) => record.entryId);
  if (previousEntryIds.every((entryId) => !entryId)) return next;
  if (isTailPageBehind(previousEntryIds, nextEntryIds)) return [...timeline];
  const firstNew = next[0].entryId;
  const index = firstNew ? previousEntryIds.indexOf(firstNew) : -1;
  if (index <= 0) return next;
  return [...timeline.slice(0, index), ...next];
}

/**
 * 主题刷新（issue #109）：把**新渲染好的行**按 entryId 套回已有时间线。
 *
 * 为什么不能复用 mergeTailRecords：那条路会把窗口换成尾页 ——
 * 已 prepend 的更早页换不到色，而 around（跳读历史）窗口还会被整段替换，
 * 把用户的阅读位置拽回最新一屏，并打断正在进行的翻页。
 *
 * 本函数只认 entryId、只换 `renderedLines`：
 * - 不动顺序、长度、key、pending 与 duringStreamingStep；
 * - 服务端这次没给出合法行（插件没有渲染器 / 渲染为空 / 该条不在这一页）时**保持原样**，
 *   宁可留着旧色，也不把已有的覆盖层清掉（清掉会从 ANSI 渲染退回纯文本，是可见的功能倒退）。
 *   代价要说清：这一层分不清「这次没带到」和「渲染器就是没有行」，所以那种记录会**一直**是旧色，
 *   直到下一次主题切换，或某次整段 replace（冷加载 / 跳读）重新渲染它；期间没有提示；
 * - 没有任何记录被替换时返回原引用，调用方据此跳过多余的 publish。
 */
export function replaceRenderedLinesByEntryId(
  timeline: Timeline,
  nextMessages: readonly AgentMessage[],
  nextEntryIds: readonly string[],
): Timeline {
  const fresh = collectRenderedLinesByEntryId(nextMessages, nextEntryIds);
  if (fresh.size === 0) return timeline;
  return applyRenderedLinesByEntryId(timeline, fresh);
}

/**
 * 从一页响应里收集 entryId → 合法 renderedLines（同 id 只取第一条）。
 * 与 {@link applyRenderedLinesByEntryId} 拆开，是为了让调用方能把结果**记住**
 * （主题换色要能在后续 hydrate 之后重新套回，见 registry 的 themeLines）。
 */
export function collectRenderedLinesByEntryId(
  nextMessages: readonly AgentMessage[],
  nextEntryIds: readonly string[],
): Map<string, string[]> {
  const fresh = new Map<string, string[]>();
  nextMessages.forEach((message, index) => {
    const entryId = nextEntryIds[index];
    if (!entryId || fresh.has(entryId)) return;
    const lines = validRenderedLines(message);
    if (lines) fresh.set(entryId, lines);
  });
  return fresh;
}

/**
 * 按 entryId 把给定行套回时间线（只换 renderedLines，结构与窗口不动）。
 * 没有任何记录被替换时返回原引用，调用方据此跳过多余的 publish。
 */
export function applyRenderedLinesByEntryId(
  timeline: Timeline,
  fresh: ReadonlyMap<string, readonly string[]>,
): Timeline {
  if (fresh.size === 0) return timeline;
  let changed = false;
  const next = timeline.map((record) => {
    const lines = record.entryId ? fresh.get(record.entryId) : undefined;
    if (!lines) return record;
    const current = (record.message as { renderedLines?: unknown }).renderedLines;
    if (sameLines(current, lines)) return record;
    changed = true;
    return { ...record, message: { ...record.message, renderedLines: [...lines] } as AgentMessage };
  });
  return changed ? next : timeline;
}

function sameLines(current: unknown, next: readonly string[]): boolean {
  return Array.isArray(current)
    && current.length === next.length
    && current.every((line, index) => line === next[index]);
}

/**
 * overlap 之后、且 previous 里没有的已确认 user 条数。
 * 只认「最后一条已确认记录仍在 next 里」之后的后缀，避免把历史扩窗/切页当成交付。
 */
function countNewTailUsers(previous: Timeline, next: Timeline): number {
  const previousIdSet = new Set(previous.map((record) => record.entryId).filter(Boolean));
  const lastPrevConfirmed = [...previous].reverse().find((record) => record.entryId);
  let start = 0;
  if (lastPrevConfirmed) {
    const overlap = next.findIndex((record) => record.entryId === lastPrevConfirmed.entryId);
    if (overlap < 0) return 0;
    start = overlap + 1;
  } else {
    for (let index = next.length - 1; index >= 0; index--) {
      if (next[index].entryId && next[index].message.role === "assistant") {
        start = index + 1;
        break;
      }
    }
  }
  let count = 0;
  for (let index = start; index < next.length; index++) {
    const record = next[index];
    if (record.entryId && !previousIdSet.has(record.entryId) && record.message.role === "user") count += 1;
  }
  return count;
}

/**
 * 归并后保留仍未被交付证据消化的乐观记录。
 *
 * 消化只发生在 overlap 锚点之后的新确认 user 上，按发送顺序一对一绑定 pending，
 * 不比较正文/附件形状（磁盘投影经常和乐观气泡不一致）。
 */
export function retainPendingRecords(previous: Timeline, next: Timeline): Timeline {
  const presentKeys = new Set(next.map((record) => record.key));
  let remainingSlots = countNewTailUsers(previous, next);
  const kept = previous.filter((record) => {
    if (!record.pending || record.entryId) return false;
    if (presentKeys.has(record.key)) return false;
    if (record.message.role === "user" && remainingSlots > 0) {
      remainingSlots -= 1;
      return false;
    }
    return true;
  });
  return kept.length === 0 ? next : [...next, ...kept];
}

export type HydratePendingPolicy = "retain" | "drop";

/** replace 默认丢掉 pending；tail/prepend 默认保留。调用方必须按意图显式覆盖。 */
export function resolveHydratePendingPolicy(
  mode: "replace" | "tail" | "prepend",
  pending?: HydratePendingPolicy,
): HydratePendingPolicy {
  if (pending === "retain" || pending === "drop") return pending;
  return mode === "replace" ? "drop" : "retain";
}

export function applyHydratePending(
  previous: Timeline,
  next: Timeline,
  pending: HydratePendingPolicy,
): Timeline {
  return pending === "drop" ? next : retainPendingRecords(previous, next);
}

export type UserConfirmationOutcome = "key" | "text" | "reconciled" | "appended" | "duplicate";

/**
 * user 消息确认（SSE `message_end`）。
 *
 * 生产 SSE 的 `message_end` 既不带 entryId 也不带 submissionId，因此：
 * 1. 有 submission key、记录仍待确认，且时间线上没有另一条同文本待确认记录
 *    → 原位确认（正文可能被插件变换）；
 * 2. 有 submission key 但记录已被磁盘归并对账掉 → `reconciled`，**不追加**。
 *    此时磁盘已有该消息，按事件再追加一条只会产生重复；但同文本的待确认记录
 *    仍要就地确认，否则它会一直是「乐观引导」被排到 live 之后（顺序错位）；
 * 3. 无 key：按正文绑定最靠后且仍 pending 的同文 user 记录（引导投递）；
 * 4. 该 entryId 已存在 → 重复；
 * 5. 其余追加。宁可多一条可见消息，也不静默丢弃服务端已观察到的消息。
 */
/** 末尾最近的、仍待确认的同文本 user 记录下标；没有则 -1。 */
function lastPendingUserIndexByText(timeline: Timeline, text: string): number {
  if (text.length === 0) return -1;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const record = timeline[index];
    if (!record.pending || record.message.role !== "user") continue;
    if (messageContentText((record.message as { content?: unknown }).content) !== text) continue;
    return index;
  }
  return -1;
}
export function confirmUserMessage(
  timeline: Timeline,
  args: { key: string | null; message: AgentMessage; entryId: string; fallbackKey: string },
): { timeline: TimelineRecord[]; outcome: UserConfirmationOutcome } {
  const { key, message, entryId, fallbackKey } = args;
  const stamped = stampEntryId(message, entryId);
  const text = messageContentText((stamped as { content?: unknown }).content);
  // 这条 message_end 真正的主人：末尾仍待确认的同文本 user 记录（引导只靠它认领）。
  const pendingTwinIdx = lastPendingUserIndexByText(timeline, text);
  if (key) {
    // 先判主人再看 key：生产 SSE 不带 submissionId，提交匹配是 FIFO 的，引导
    // （无 submission）的 message_end 会把别人的 key 领走。若时间线上另有一条
    // 同文本待确认记录，这条事件属于它——按 key 替换只会覆盖别人的消息，而那条
    // 引导则永远得不到确认，被 compositor 一直排到 live 之后。
    const keyed = pendingTwinIdx < 0 || timeline[pendingTwinIdx]?.key === key
      ? findRecord(timeline, key)
      : undefined;
    if (keyed?.pending) {
      const replaced = replaceRecord(timeline, key, stamped, entryId);
      if (replaced) return { timeline: replaced, outcome: "key" };
    }
    // 乐观记录已不在时间线里。只有**确实找到了它**才算交付证据：
    // 有 entryId 时按 id 命中，否则按同文本且已带 entryId 的磁盘记录命中。
    // 否则那只是一份尚未包含该提交的快照替换掉了它——不是交付证据，
    // 必须继续走下面的归并，避免服务端已观察到的消息被静默丢弃。
    const deliveredByDisk = entryId
      ? timeline.some((record) => record.entryId === entryId)
      : text.length > 0
        && timeline.some((record) => record.entryId
          && messageContentText((record.message as { content?: unknown }).content) === text);
    if (deliveredByDisk) {
      // 磁盘已有这条消息 ≠ 那条待确认记录已经确认。留着它会让引导气泡继续被
      // 后置到 live 之后（顺序错位到下一次 hydrate 为止），必须就地确认。
      if (pendingTwinIdx >= 0) {
        const replaced = replaceRecord(timeline, timeline[pendingTwinIdx].key, stamped, entryId);
        if (replaced) return { timeline: replaced, outcome: "text" };
      }
      return { timeline: [...timeline], outcome: "reconciled" };
    }
  }
  if (pendingTwinIdx >= 0) {
    const replaced = replaceRecord(timeline, timeline[pendingTwinIdx].key, stamped, entryId);
    if (replaced) return { timeline: replaced, outcome: "text" };
  }
  if (entryId && timeline.some((record) => record.entryId === entryId)) {
    return { timeline: [...timeline], outcome: "duplicate" };
  }
  return {
    timeline: appendRecord(timeline, { key: fallbackKey, message: stamped, entryId, pending: false }),
    outcome: "appended",
  };
}
