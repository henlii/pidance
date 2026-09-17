/**
 * 本地 follow-up 队列状态（纯函数，按 sessionId 分账）。
 *
 * Host 是队列的唯一 owner：条目身份（id）、状态（waiting/claimed/unknown）与
 * revision 都由服务端给出。浏览器只持有
 *
 * - `items`：服务端最近一次权威快照里**可见**的条目（waiting + unknown）；
 * - `inFlight`：已提交给 Pi、尚未确认的正文（claimed）；
 * - `pending`：本地乐观**提交链**（每个提交带自己的整包快照，最旧的在前）；
 * - `serverRevision`：CAS 基线，下一次写入的 expectedRevision 就是它。
 *
 * 五条不变量，各对应一个已发生过的缺陷：
 *
 * 1. **显示 = 最新 pending ?? items**。回滚是清掉 pending 退回权威条目，而不是
 *    「恢复上一份乐观值」——空队列连续写 [A]、[A,B] 都失败时仍显示 []。
 * 2. **内容与版本一次写入**。冲突回执必须同时采纳权威 items 与 revision；
 *    只更新版本（旧行为）会形成「新版本 + 旧内容」，下一次合法 CAS 就删掉别人
 *    刚入队的消息（R2）。
 * 3. **成功回执即新基线**。写成功后必须采纳回执里的 revision，否则下一次写入带
 *    过期版本被 CAS 拒绝，表现为「入队成功但转引导失败」，只能靠后续轮询偶然
 *    恢复（R1）。
 * 4. **按 sessionId 分账**。切走会话后失败也只能修正原会话条目。
 * 5. **链上的后继不得升到新基线**（F11）。每个提交发自己的快照；一旦某个提交
 *    失败（尤其 CAS 冲突），它与其后继一起作废并让调用方回滚草稿——旧行为是
 *    后继在实际执行时才读「最新 pending」，冲突后直接拿新版本把旧整包写上去，
 *    把另一标签页刚入队的消息删掉。
 */

import type { QueueItemPayload } from "./agent-commands";
import type { FollowUpItem, FollowUpItemState, QueuedMediaRef } from "./session-queue";

export type { QueueItemPayload };

/** 权威条目 → 写入载荷（媒体按引用回传，Host 按路径复用同一份文件）。 */
export function itemToPayload(item: FollowUpItem): QueueItemPayload {
  return {
    text: item.text,
    ...(item.media?.length ? { media: item.media.map((ref) => ({ ...ref })) } : {}),
  };
}

function toPayload(value: string | QueueItemPayload): QueueItemPayload {
  return typeof value === "string" ? { text: value } : value;
}

/** 一次乐观提交：整包快照 + 本地代次（结算 CAS 用）。 */
export type QueueProposal = {
  revision: number;
  payloads: QueueItemPayload[];
};

export type QueueEntry = {
  /** 权威可见条目（waiting + unknown），含身份、状态与图片引用。 */
  items: FollowUpItem[];
  /** 已提交未确认的正文（claimed）。 */
  inFlight: string[];
  /** 乐观提交链（最旧在前）。显示用最后一个，写入逐个发各自的快照。 */
  pending: QueueProposal[];
  /** 本地代次：每次提出提交 +1。 */
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
  pending: [],
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

/** 提交链里最新的一次（显示与「下一个要写什么」都以它为准）。 */
export function latestPending(entry: QueueEntry): QueueProposal | null {
  return entry.pending.length ? entry.pending[entry.pending.length - 1] : null;
}

/**
 * 这次提交是否还在链上（没被结算、也没被前一个提交的失败连带作废）。
 *
 * 写入前必须问一次：前一个提交冲突时，后继整包是基于旧权威基线的，发送就会
 * 把另一标签页的条目覆盖掉（F11）。
 */
export function isQueueProposalLive(entry: QueueEntry, revision: number): boolean {
  return entry.pending.some((proposal) => proposal.revision === revision);
}

/** 显示投影：优先最新乐观提交，否则回落到权威条目。 */
export function projection(entry: QueueEntry): string[] {
  const latest = latestPending(entry);
  return latest ? latest.payloads.map((payload) => payload.text) : sendableItemTexts(entry.items);
}

/**
 * 下一次写入 Host 的整包载荷（正文 + 图片引用）。
 *
 * 有乐观值时以它为准（它就是用户想看到的目标状态），否则从权威条目重建；
 * 两者都必须把图片带上，否则一次「只传正文」的写入会让 Host 丢掉队列里的图。
 * 注意：真正写入时用的是**该次提交自己的快照**（proposeQueue 的返回值），
 * 不是这个函数——链上的每个提交各发各的。
 */
export function payloadsForWrite(entry: QueueEntry): QueueItemPayload[] {
  const latest = latestPending(entry);
  return latest ? latest.payloads : entry.items.filter((item) => item.state !== "claimed").map(itemToPayload);
}

/** 权威条目 → 写入载荷（正文 + 该条目的媒体引用，逐条保留配对）。 */
export function queueItemPayloads(items: readonly FollowUpItem[]): QueueItemPayload[] {
  return items.filter((item) => item.state !== "claimed").map(itemToPayload);
}

/** 权威条目里的媒体引用按顺序摊平（取回时按图片分组重建附件）。 */
export function itemMediaRefs(items: readonly FollowUpItem[]): QueuedMediaRef[] {
  return items.flatMap((item) => item.media ?? []);
}

/**
 * UI 行投影：权威条目 + 在途行，供队列面板显示状态与图片数量。
 *
 * 图片数量只数原图：一张图在条目里有两份副本（模型/原图），数量要对得上
 * 用户看见的图。
 */
export function queueRows(entry: QueueEntry): {
  id: string;
  text: string;
  state: FollowUpItemState;
  imageCount: number;
}[] {
  const count = (media?: readonly QueuedMediaRef[]): number => {
    if (!media?.length) return 0;
    const originals = media.filter((ref) => ref.role === "original").length;
    return originals || media.length;
  };
  if (entry.pending.length) {
    const payloads = entry.pending[entry.pending.length - 1].payloads;
    return payloads.map((payload, index) => ({
      id: `pending-${index}`,
      text: payload.text,
      state: "waiting" as const,
      imageCount: count(payload.media),
    }));
  }
  return [
    ...entry.items.map((item) => ({
      id: item.id,
      text: item.text,
      state: item.state,
      imageCount: count(item.media),
    })),
    ...entry.inFlight.map((text, index) => ({
      id: `inflight-${index}`,
      text,
      state: "claimed" as const,
      imageCount: 0,
    })),
  ];
}

/** 是否有在途本地改动（仅影响显示，不影响权威快照落地）。 */
export function hasPendingLocalChange(entry: QueueEntry): boolean {
  return entry.pending.length > 0;
}

function put(book: QueueBook, sessionId: string, entry: QueueEntry): QueueBook {
  return { ...book, [sessionId]: entry };
}

/** 提出新的乐观提交；返回本次代次与快照供结算/写入。 */
export function proposeQueue(
  book: QueueBook,
  sessionId: string,
  items: readonly (string | QueueItemPayload)[],
): { book: QueueBook; revision: number; payloads: QueueItemPayload[] } {
  const entry = queueEntry(book, sessionId);
  const revision = entry.revision + 1;
  const payloads = items.map(toPayload);
  return {
    book: put(book, sessionId, {
      ...entry,
      pending: [...entry.pending, { revision, payloads }],
      revision,
    }),
    revision,
    payloads,
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

/** 提交成功：该次提交出链，仍未结算的后继保留（基线随回执推进）。 */
export function settleSyncSuccess(
  book: QueueBook,
  sessionId: string,
  revision: number,
  snapshot: QueueSnapshot,
): QueueBook {
  const adopted = adoptServerSnapshot(book, sessionId, snapshot);
  const entry = queueEntry(adopted, sessionId);
  const pending = entry.pending.filter((proposal) => proposal.revision !== revision);
  if (pending.length === entry.pending.length) return adopted;
  return put(adopted, sessionId, { ...entry, pending });
}

/**
 * 提交失败：该次提交**连同其后继**一起作废，退回权威条目。
 *
 * 后继整包是在「这次写入会成功」的前提下算出来的；一次失败（尤其 CAS 冲突）
 * 之后继续把它们发出去，就是用旧基线的新版本覆盖服务端刚发生的改动（F11）。
 * 调用方必须因此收到拒绝并把内容退回草稿。
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
  const pending = entry.pending.filter((proposal) => proposal.revision < revision);
  if (pending.length === entry.pending.length) return adopted;
  return put(adopted, sessionId, { ...entry, pending });
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
