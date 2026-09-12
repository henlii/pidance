/**
 * 本地 follow-up 队列状态（纯函数，按 sessionId 分账）。
 *
 * Host 是队列的持久化 owner；浏览器只持有「已确认基线 + 一个乐观待提交值」。
 * 三条不变量，对应三个已发生过的缺陷：
 *
 * 1. **显示 = pending ?? confirmed**。回滚是把 pending 清掉退回基线，而不是
 *    「恢复上一份乐观值」——空队列连续写 [A]、[A,B] 都失败时，基线仍是 []，
 *    不会显示从未被服务端接受过的 [A]。
 * 2. **按 revision 做 CAS**。本地每次提出新 pending 都推进 revision；
 *   在途请求带自己的 revision，结算时 revision 不匹配就丢弃，避免旧结果
 *    覆盖更新的写入。
 * 3. **按 sessionId 分账**。切走会话后失败也要修正原会话条目，而不是改当前投影。
 *
 * `syncs` 是在途提交计数：并发入队时先完成的一笔不得提前放行服务端投影。
 */

export type QueueEntry = {
  /** 最后一次被服务端/磁盘确认的队列。 */
  confirmed: string[];
  /** 乐观待提交值；null = 没有在途本地改动。 */
  pending: string[] | null;
  /** 本地代次：每次提出 pending 或接受确认 +1。 */
  revision: number;
  /** 在途 set_follow_up_queue 计数。 */
  syncs: number;
};

export type QueueBook = Readonly<Record<string, QueueEntry>>;

const EMPTY: QueueEntry = { confirmed: [], pending: null, revision: 0, syncs: 0 };

export function queueEntry(book: QueueBook, sessionId: string): QueueEntry {
  return book[sessionId] ?? EMPTY;
}

/** 显示投影：优先乐观待提交值，否则回落到已确认基线。 */
export function projection(entry: QueueEntry): string[] {
  return [...(entry.pending ?? entry.confirmed)];
}

/** 是否有在途本地改动（服务端旧快照不得覆盖）。 */
export function hasPendingLocalChange(entry: QueueEntry): boolean {
  return entry.pending !== null;
}

/** 在途同步是否已归零（归零才允许服务端投影落地）。 */
export function canAcceptObservation(entry: QueueEntry): boolean {
  return entry.syncs <= 0;
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

export function beginSync(book: QueueBook, sessionId: string): QueueBook {
  const entry = queueEntry(book, sessionId);
  return put(book, sessionId, { ...entry, syncs: entry.syncs + 1 });
}

/** 结束一笔在途提交（可与成功/失败结算合并调用）。 */
export function endSync(book: QueueBook, sessionId: string): QueueBook {
  const entry = queueEntry(book, sessionId);
  return put(book, sessionId, { ...entry, syncs: Math.max(0, entry.syncs - 1) });
}

/**
 * 提交成功：该代次的 pending 转为新的已确认基线。
 * revision 不匹配说明期间有更新的写入，本次结果作废（但同步计数照常归还）。
 */
export function settleSyncSuccess(
  book: QueueBook,
  sessionId: string,
  revision: number,
  items: readonly string[],
): QueueBook {
  const entry = queueEntry(book, sessionId);
  const next = put(book, sessionId, { ...entry, syncs: Math.max(0, entry.syncs - 1) });
  if (entry.revision !== revision) return next;
  const current = queueEntry(next, sessionId);
  return put(next, sessionId, { ...current, confirmed: [...items], pending: null });
}

/** 提交失败：清掉该代次的乐观值，退回已确认基线。 */
export function settleSyncFailure(
  book: QueueBook,
  sessionId: string,
  revision: number,
): QueueBook {
  const entry = queueEntry(book, sessionId);
  const next = put(book, sessionId, { ...entry, syncs: Math.max(0, entry.syncs - 1) });
  if (entry.revision !== revision) return next;
  const current = queueEntry(next, sessionId);
  return put(next, sessionId, { ...current, pending: null });
}

/**
 * 服务端/prefs 的权威观察。
 * `requestRevision` 是发起请求时捕获的代次：期间发生过本地写入或仍有在途提交时
 * 丢弃该响应，避免「请求早于写入、响应晚于归零」把新值覆盖掉。
 */
export function observeQueue(
  book: QueueBook,
  sessionId: string,
  items: readonly string[],
  requestRevision: number,
): QueueBook {
  const entry = queueEntry(book, sessionId);
  if (entry.revision !== requestRevision) return book;
  if (!canAcceptObservation(entry)) return book;
  if (hasPendingLocalChange(entry)) return book;
  return put(book, sessionId, { ...entry, confirmed: [...items] });
}

/**
 * Host 队列快照的新旧判定。
 *
 * Host 为队列维护单调 revision（每次内容变更 +1），快照可能因 SSE/轮询/偏好同步
 * 乱序到达；过期快照会把「已经被 steer 带走的队列」重新写回 UI（实测：引导整队
 * 发送后队列又出现）。因此客户端只接受 >= 已见版本的快照。
 *
 * 快照未带版本（旧 Host / 旧持久化数据）时不做判定，照旧接受。
 */
export function acceptRemoteQueue(
  seen: number | undefined,
  revision: number | null | undefined,
): { accept: boolean; seen: number | undefined } {
  if (typeof revision !== "number") return { accept: true, seen };
  if (seen !== undefined && revision < seen) return { accept: false, seen };
  return { accept: true, seen: revision };
}
