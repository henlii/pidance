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
 * 尾页重载合并：保留本地已加载、且不在新尾页中的更旧前缀；
 * 用新尾页替换重叠段及之后（含新产生的消息）。
 * 用于 agent_end reload / 同会话 tail 再拉，避免丢掉已 prepend 的历史。
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
  const firstNew = next[0].entryId;
  const index = firstNew ? previousEntryIds.indexOf(firstNew) : -1;
  if (index <= 0) return next;
  return [...timeline.slice(0, index), ...next];
}

/**
 * 归并后保留仍未被磁盘包含的乐观记录。
 *
 * hydrate 用磁盘快照替换/覆盖尾部时，未确认的乐观气泡（无 entryId）会被丢掉；
 * 若那份快照尚未包含刚发出的消息，用户会看到气泡消失、随后又出现，
 * 而迟到的 message_end 也再无记录可绑定。这里把「磁盘确实还没有」的乐观记录
 * 重新挂回尾部，直到磁盘真正包含它。
 *
 * 只用于同会话重载（tail/prepend）；换会话或分支切换（replace）不保留。
 */
export function retainPendingRecords(previous: Timeline, next: Timeline): Timeline {
  const presentKeys = new Set(next.map((record) => record.key));
  const presentTexts = new Set(
    next
      .filter((record) => record.entryId)
      .map((record) => messageContentText((record.message as { content?: unknown }).content)),
  );
  const kept = previous.filter((record) => {
    if (!record.pending || record.entryId) return false;
    // 归并本身已保留它（如 prepend 不动尾部）→ 不重复追加。
    if (presentKeys.has(record.key)) return false;
    const text = messageContentText((record.message as { content?: unknown }).content);
    // 磁盘已包含同文本条目 → 乐观记录已被权威视图取代。
    return text.length === 0 || !presentTexts.has(text);
  });
  return kept.length === 0 ? next : [...next, ...kept];
}

export type UserConfirmationOutcome = "key" | "text" | "reconciled" | "appended" | "duplicate";

/**
 * user 消息确认（SSE `message_end`）。
 *
 * 生产 SSE 的 `message_end` 既不带 entryId 也不带 submissionId，因此：
 * 1. 有 submission key 且记录还在 → 原位确认（正文可能被插件变换）；
 * 2. 有 submission key 但记录已被磁盘归并对账掉 → `reconciled`，**不追加**。
 *    此时磁盘已有该消息，按事件再追加一条只会产生重复；
 * 3. 无 key：按正文绑定最靠后且仍 pending 的同文 user 记录（引导投递）；
 * 4. 该 entryId 已存在 → 重复；
 * 5. 其余追加。宁可多一条可见消息，也不静默丢弃服务端已观察到的消息。
 */
export function confirmUserMessage(
  timeline: Timeline,
  args: { key: string | null; message: AgentMessage; entryId: string; fallbackKey: string },
): { timeline: TimelineRecord[]; outcome: UserConfirmationOutcome } {
  const { key, message, entryId, fallbackKey } = args;
  const stamped = stampEntryId(message, entryId);
  const text = messageContentText((stamped as { content?: unknown }).content);
  if (key) {
    const replaced = replaceRecord(timeline, key, stamped, entryId);
    if (replaced) return { timeline: replaced, outcome: "key" };
    // 乐观记录已不在时间线里。只有**确实找到了它**才算交付证据：
    // 有 entryId 时按 id 命中，否则按同文本且已带 entryId 的磁盘记录命中。
    // 否则那只是一份尚未包含该提交的快照替换掉了它——不是交付证据，
    // 必须继续走下面的归并，避免服务端已观察到的消息被静默丢弃。
    const deliveredByDisk = entryId
      ? timeline.some((record) => record.entryId === entryId)
      : text.length > 0
        && timeline.some((record) => record.entryId
          && messageContentText((record.message as { content?: unknown }).content) === text);
    if (deliveredByDisk) return { timeline: [...timeline], outcome: "reconciled" };
  }
  if (text.length > 0) {
    for (let index = timeline.length - 1; index >= 0; index--) {
      const record = timeline[index];
      if (!record.pending || record.message.role !== "user") continue;
      if (messageContentText((record.message as { content?: unknown }).content) !== text) continue;
      const replaced = replaceRecord(timeline, record.key, stamped, entryId);
      if (replaced) return { timeline: replaced, outcome: "text" };
    }
  }
  if (entryId && timeline.some((record) => record.entryId === entryId)) {
    return { timeline: [...timeline], outcome: "duplicate" };
  }
  return {
    timeline: appendRecord(timeline, { key: fallbackKey, message: stamped, entryId, pending: false }),
    outcome: "appended",
  };
}
