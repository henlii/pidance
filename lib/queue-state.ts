/**
 * 本地 follow-up 队列状态（纯函数，按 sessionId 分账）。
 *
 * Host 是队列的唯一 owner：条目身份（id）、状态（waiting/claimed/unknown）与
 * revision 都由服务端给出。浏览器只持有
 *
 * - `items`：服务端最近一次权威快照里**可见**的条目（waiting + unknown）；
 * - `inFlight`：已提交给 Pi、尚未确认的正文（claimed）；
 * - `pending`：本地乐观待提交值（尚未拿到回执）；
 * - `serverRevision`：CAS 基线，下一次写入的 expectedRevision 就是它。
 *
 * 四条不变量，各对应一个已发生过的缺陷：
 *
 * 1. **显示 = pending ?? items**。回滚是清掉 pending 退回权威条目，而不是
 *    「恢复上一份乐观值」——空队列连续写 [A]、[A,B] 都失败时仍显示 []。
 * 2. **内容与版本一次写入**。冲突回执必须同时采纳权威 items 与 revision；
 *    只更新版本（旧行为）会形成「新版本 + 旧内容」，下一次合法 CAS 就删掉别人
 *    刚入队的消息（R2）。
 * 3. **成功回执即新基线**。写成功后必须采纳回执里的 revision，否则下一次写入带
 *    过期版本被 CAS 拒绝，表现为「入队成功但转引导失败」，只能靠后续轮询偶然
 *    恢复（R1）。
 * 4. **按 sessionId 分账**。切走会话后失败也只能修正原会话条目。
 */

import type { FollowUpItem, FollowUpItemState } from "./session-queue";

export type QueueEntry = {
  /** 权威可见条目（waiting + unknown），含身份与状态。 */
  items: FollowUpItem[];
  /** 已提交未确认的正文（claimed）。 */
  inFlight: string[];
  /** 乐观待提交值；null = 没有在途本地改动。 */
  pending: string[] | null;
  /** 本地代次：每次提出 pending 或采纳快照 +1。 */
  revision: number;
  /** 服务端 CAS 基线；null = 未知（旧数据），此时不带 expectedRevision。 */
  serverRevision: number | null;
};

export type QueueBook = Readonly<Record<string, QueueEntry>>;

export type QueueSnapshot = {
  items: FollowUpItem[];
  revision: number | null;
  inFlight?: string[];
};

const EMPTY: QueueEntry = {
  items: [],
  inFlight: [],
  pending: null,
  revision: 0,
  serverRevision: null,
};

export function queueEntry(book: QueueBook, sessionId: string): QueueEntry {
  return book[sessionId] ?? EMPTY;
}

/** 队列内容（不含在途）。 */
export function queueItemTexts(items: readonly FollowUpItem[]): string[] {
  return items.map((item) => item.text);
}

/** 待发送条目（unknown 不自动投递，但仍在队列里等用户处置）。 */
export function sendableItemTexts(items: readonly FollowUpItem[]): string[] {
  return items.filter((item) => item.state !== "claimed").map((item) => item.text);
}

/** 显示投影：优先乐观待提交值，否则回落到权威条目。 */
export function projection(entry: QueueEntry): string[] {
  return [...(entry.pending ?? sendableItemTexts(entry.items))];
}

/** UI 行投影：权威条目 + 在途行，供队列面板显示状态。 */
export function queueRows(entry: QueueEntry): { id: string; text: string; state: FollowUpItemState }[] {
  if (entry.pending) {
    return entry.pending.map((text, index) => ({ id: `pending-${index}`, text, state: "waiting" as const }));
  }
  return [
    ...entry.items.map((item) => ({ id: item.id, text: item.text, state: item.state })),
    ...entry.inFlight.map((text, index) => ({ id: `inflight-${index}`, text, state: "claimed" as const })),
  ];
}

/** 是否有在途本地改动（仅影响显示，不影响权威快照落地）。 */
export function hasPendingLocalChange(entry: QueueEntry): boolean {
  return entry.pending !== null;
}

function put(book: QueueBook, sessionId: string, entry: QueueEntry): QueueBook {
  return { ...book, [sessionId]: entry };
}

/** 提出新的乐观值；返回本次代次供结算 CAS。 */
export function proposeQueue(
  book: QueueBook,
  sessionId: string,
  items: readonly string[],
): { book: QueueBook; revision: number } {
  const entry = queueEntry(book, sessionId);
  const revision = entry.revision + 1;
  return {
    book: put(book, sessionId, { ...entry, pending: [...items], revision }),
    revision,
  };
}

/**
 * 采纳权威快照（SSE 投影 / 写入回执 / prefs 回读）。
 *
 * 内容与版本**一起**落地；过期快照（revision 小于已见）整份丢弃，避免
 * 「已经被 steer 带走的队列」被旧快照写回 UI，也避免旧版本回退 CAS 基线。
 * `pending` 与 `revision`（本地代次）不受影响：显示仍优先乐观值，
 * 在途写入的结算 CAS 也因此仍然有效。
 */
export function adoptServerSnapshot(
  book: QueueBook,
  sessionId: string,
  snapshot: QueueSnapshot,
): QueueBook {
  const entry = queueEntry(book, sessionId);
  const incoming = snapshot.revision;
  if (
    typeof incoming === "number"
    && typeof entry.serverRevision === "number"
    && incoming < entry.serverRevision
  ) {
    return book;
  }
  return put(book, sessionId, {
    ...entry,
    items: [...snapshot.items],
    inFlight: [...(snapshot.inFlight ?? [])],
    serverRevision: typeof incoming === "number" ? incoming : entry.serverRevision,
  });
}

/** 提交成功：该代次的 pending 转成回执里的权威条目。 */
export function settleSyncSuccess(
  book: QueueBook,
  sessionId: string,
  revision: number,
  snapshot: QueueSnapshot,
): QueueBook {
  const adopted = adoptServerSnapshot(book, sessionId, snapshot);
  const entry = queueEntry(adopted, sessionId);
  if (entry.revision !== revision) return adopted;
  return put(adopted, sessionId, { ...queueEntry(adopted, sessionId), pending: null });
}

/**
 * 提交失败：清掉该代次的乐观值，退回权威条目。
 * 冲突回执同样必须采纳权威内容（否则内容与版本不一致）。
 */
export function settleSyncFailure(
  book: QueueBook,
  sessionId: string,
  revision: number,
  snapshot?: QueueSnapshot,
): QueueBook {
  const adopted = snapshot ? adoptServerSnapshot(book, sessionId, snapshot) : book;
  const entry = queueEntry(adopted, sessionId);
  if (entry.revision !== revision) return adopted;
  return put(adopted, sessionId, { ...queueEntry(adopted, sessionId), pending: null });
}

/** 服务端队列回执的形状（写入与派发共用）。 */
export type QueueReceiptView = {
  ok?: boolean;
  conflict?: boolean;
  persist?: boolean;
  revision?: number;
  items?: unknown;
  inFlight?: unknown;
};

export function isQueueWriteConflict(result: unknown): boolean {
  return Boolean(
    result
    && typeof result === "object"
    && (result as QueueReceiptView).conflict === true,
  );
}
