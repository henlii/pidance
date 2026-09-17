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
    id: item.id,
    text: item.text,
    ...(item.media?.length ? { media: item.media.map((ref) => ({ ...ref })) } : {}),
  };
}

/** 客户端新写入的载荷（带本次尝试令牌，失败时可判定是否受理过）。 */
export function newPayload(
  text: string,
  options?: { media?: QueuedMediaRef[]; attemptId?: string },
): QueueItemPayload {
  return {
    text,
    ...(options?.media?.length ? { media: options.media } : {}),
    attemptId: options?.attemptId ?? newQueueAttemptId(),
  };
}

/** 写入结果处置分类（唯一判定点：成功/失败本身不足以判定移交）。 */
export type QueueWriteDisposition = "accepted" | "conflict" | "rejected" | "unknown";

/**
 * 把「回执或错误」归入四类处置。
 *
 * - `accepted`：Host 确认受理并落盘（唯一能证明内容已入队列的回执）；
 * - `conflict`：权威状态已知且本次未生效（CAS 冲突/在途冲突/已认领不可撤回）；
 * - `rejected`：确定未受理（结构性拒绝、落盘失败、4xx）；
 * - `unknown`：网络/超时等无定论——既不能当成功也不能当失败。
 */
export function classifyQueueOutcome(
  result: unknown,
  options?: { error?: unknown; definitiveRejection?: (error: unknown) => boolean },
): QueueWriteDisposition {
  if (options?.error !== undefined) {
    return options.definitiveRejection?.(options.error) ? "rejected" : "unknown";
  }
  if (!result || typeof result !== "object") return "unknown";
  const view = result as QueueReceiptView;
  if (view.conflict === true) return "conflict";
  if (view.ok === true) return "accepted";
  if (typeof view.ok === "boolean") return "rejected";
  return "unknown";
}

function toPayload(value: string | QueueItemPayload): QueueItemPayload {
  return typeof value === "string" ? { text: value } : value;
}

/** 一次乐观提交：显示投影 + 可恢复候选 + 本地代次（结算 CAS 用）。 */
export type QueueProposal = {
  revision: number;
  /** 该操作完成后用户应看到的队列条目（纯显示/回退目标）。 */
  payloads: QueueItemPayload[];
  /**
   * 本次操作中「客户端新写入、队列尚未确认持有」的载荷——失败恢复的**唯一**候选集。
   *
   * 从队列拷回来的载荷没有 attemptId，永远不会出现在这里：它们是队列自己持有的
   * 内容，不能又变成一份可重发副本（H1）。
   */
  candidates: QueueItemPayload[];
  /** `sending` = 在途；`uncertain` = 结果未知、待确认（内容仍归队列侧）。 */
  state: "sending" | "uncertain";
  /** 提交幂等键：重试同一次提交（结果未知时）必须复用它，Host 才能给出已缓存的定论。 */
  submissionId: string;
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
  /** Host 已受理的写入尝试令牌（判断「我的写入进没进队列」的唯一凭据）。 */
  admittedAttemptIds: string[];
};

export type QueueBook = Readonly<Record<string, QueueEntry>>;

export type QueueSnapshot = {
  items: FollowUpItem[];
  revision: number | null;
  inFlight?: string[];
  admittedAttemptIds?: string[];
};

const EMPTY: QueueEntry = {
  items: [],
  inFlight: [],
  pending: [],
  revision: 0,
  serverRevision: null,
  admittedAttemptIds: [],
};

/**
 * 写入尝试令牌：每次写入尝试新生成一个，**绝不重用**。
 *
 * 重用会让「这个令牌受理过吗」失去意义：召回后再重发会拿到旧令牌的受理记录，
 * 于是一次真正失败的写入被当成绩已受理，内容就永远不会回到草稿。
 */
export function newQueueAttemptId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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

/** 队列是否处于「上一次写入结果未知、等确认」状态。 */
export function hasUncertainWrite(entry: QueueEntry): boolean {
  return entry.pending.some((proposal) => proposal.state === "uncertain");
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
    const latest = entry.pending[entry.pending.length - 1];
    return latest.payloads.map((payload, index) => ({
      id: `pending-${index}`,
      text: payload.text,
      // 结果未知的提交在 UI 上就是「待确认」：既不装作已排队，也不假装内容已丢。
      state: latest.state === "uncertain" ? ("unknown" as const) : ("waiting" as const),
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
  const write = proposeQueueWrite(book, sessionId, {
    payloads: items,
    candidates: items.filter((item): item is QueueItemPayload => typeof item !== "string"),
  });
  return { book: write.book, revision: write.revision, payloads: write.payloads };
}

/**
 * 提出一次任意队列操作（入队 / 派发 / 召回）。
 *
 * `payloads` 是显示投影，`candidates` 是本次可能被写入队列的客户端载荷。
 * 两者分开：派发操作要显示「这批条目正在投递」，但只可能把输入框里的 extra
 * 留在队列里；召回的候选集为空（取回内容以回执为准）。
 */
export function proposeQueueWrite(
  book: QueueBook,
  sessionId: string,
  options: {
    payloads: readonly (string | QueueItemPayload)[];
    candidates?: readonly QueueItemPayload[];
    submissionId?: string;
  },
): {
  book: QueueBook;
  revision: number;
  payloads: QueueItemPayload[];
  candidates: QueueItemPayload[];
  submissionId: string;
} {
  const entry = queueEntry(book, sessionId);
  const revision = entry.revision + 1;
  const payloads = options.payloads.map(toPayload);
  const candidates = [...(options.candidates ?? [])];
  const submissionId = options.submissionId ?? newQueueAttemptId();
  return {
    book: put(book, sessionId, {
      ...entry,
      pending: [...entry.pending, { revision, payloads, candidates, state: "sending", submissionId }],
      revision,
    }),
    revision,
    payloads,
    candidates,
    submissionId,
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
    admittedAttemptIds: snapshot.admittedAttemptIds
      ? [...snapshot.admittedAttemptIds]
      : entry.admittedAttemptIds,
  });
}

/**
 * 快照是否可信到可以当权威。
 *
 * 只有带服务端 revision 的回执才算一次真实的队列读：路由层的 400 空体（命令本身
 * 不合法）也会被包成快照，拿它去改账本等于用「空队列」覆盖用户看到的队列。
 */
function authoritativeSnapshot(snapshot?: QueueSnapshot): QueueSnapshot | undefined {
  return snapshot && typeof snapshot.revision === "number" ? snapshot : undefined;
}

/**
 * 用权威快照给「更早的未决提交」定论（I7 的成功路径 / J1 的冲突、拒绝路径）。
 *
 * 返回需要回到草稿的载荷，以及被定论掉的本地代次。判定只用两个服务端事实：
 * - 载荷的 attemptId 在 `admittedAttemptIds` 里 → 队列已持有它（还在队列里就在
 *   快照的 items 里，已经不在了就是已被投递），**不恢复**；
 * - 不在里面 → 这次写入从未被受理 → 内容安全地回到草稿（不会复制出重复副本）。
 *
 * `seen` 由调用方跨批次传入：同一次载荷可能同时出现在前一批与后继里，只归还一次。
 */
function settleUnsettledByAuthority(
  entry: QueueEntry,
  settledRevision: number,
  admitted: ReadonlySet<string>,
  seen: Set<string>,
): { revisions: Set<number>; resolved: QueueItemPayload[] } {
  const revisions = new Set<number>();
  const resolved: QueueItemPayload[] = [];
  for (const proposal of entry.pending) {
    if (proposal.revision >= settledRevision) continue;
    revisions.add(proposal.revision);
    for (const payload of proposal.candidates) {
      const attemptId = payload.attemptId;
      if (!attemptId || seen.has(attemptId) || admitted.has(attemptId)) continue;
      seen.add(attemptId);
      resolved.push(payload);
    }
  }
  return { revisions, resolved };
}

/** 服务端队列回执的形状（写入与派发共用）。 */
export type QueueReceiptView = {
  ok?: boolean;
  conflict?: boolean;
  persist?: boolean;
  revision?: number;
  items?: unknown;
  inFlight?: unknown;
  admittedAttemptIds?: unknown;
};

export function isQueueWriteConflict(result: unknown): boolean {
  return Boolean(
    result
    && typeof result === "object"
    && (result as QueueReceiptView).conflict === true,
  );
}

/**
 * 权威快照解决未决提交（issue #42 / I7、J1）。
 *
 * 一次带权威快照的写入结果（受理，或冲突/拒绝但回执里带着服务端队列）意味着 Host
 * 的队列状态**此刻**已知：所有**不晚于**它的本地提交都已经有了定论。旧实现只把
 * 「本次提交」出链，于是更早的 unknown 提交会永远留在链上——它的正文会继续盖住
 * 刚采纳的权威快照，下一次入队又把它整包写回去，删掉别的标签页刚入队的条目。
 *
 * 其后尚未发送的后继提交按身份重整：引用「已不在队列里的身份」的载荷从写入里
 * 去掉——否则后继会把已召回的条目又写成新条目，或把在途条目投递第二次。
 */
function resolvePendingsAgainstAuthority(
  book: QueueBook,
  sessionId: string,
  settledRevision: number,
  snapshot: QueueSnapshot,
): { book: QueueBook; resolved: QueueItemPayload[] } {
  const adopted = adoptServerSnapshot(book, sessionId, snapshot);
  const entry = queueEntry(adopted, sessionId);
  const admitted = new Set(snapshot.admittedAttemptIds ?? entry.admittedAttemptIds);
  const liveIds = new Set(snapshot.items.map((item) => item.id));
  const later = entry.pending.filter((proposal) => proposal.revision > settledRevision);
  const seen = new Set<string>();
  // 更早的未决提交（本次之外的）：它们的效果已经含在快照里。
  const reclaimed = settleUnsettledByAuthority(entry, settledRevision, admitted, seen).resolved;
  const gone = (payload: QueueItemPayload): boolean => {
    if (payload.attemptId && seen.has(payload.attemptId)) return true;
    return Boolean(payload.id && !liveIds.has(payload.id));
  };
  const pending = later.map((proposal) => {
    const payloads = proposal.payloads.filter((payload) => !gone(payload));
    const candidates = proposal.candidates.filter((payload) => !gone(payload));
    if (payloads.length === proposal.payloads.length && candidates.length === proposal.candidates.length) {
      return proposal;
    }
    return { ...proposal, payloads, candidates };
  });
  const untouched = entry.pending.every((proposal) => proposal.revision > settledRevision)
    && pending.every((proposal, index) => proposal === later[index]);
  return {
    book: untouched ? adopted : put(adopted, sessionId, { ...entry, pending }),
    resolved: reclaimed,
  };
}

/**
 * 写入结算——**消息所有权的唯一判定处**（issue #42 / H1–H3）。
 *
 * 规则（与 host 侧 `admittedAttemptIds` 配对）：
 * 1. `accepted`：队列持有全部载荷 → 什么都不恢复（否则草稿与队列各一份）；
 * 2. `conflict`：权威快照已知且本次未生效 → 只归还**从未被受理过**的候选载荷
 *    （从队列拷回来的载荷没有令牌，不进候选集），并采纳权威内容与版本；
 * 3. `rejected`：确定未受理 → 同上（候选载荷中未受理的那些归还草稿）；
 * 4. `unknown`：结果未知——内容留在队列侧并标记待确认，**绝不**同时复制成草稿
 *    （那是重复发送的入口，也可能把已投递的消息又发一遍）。
 *
 * 失败（conflict / rejected）时连同后继提交一起作废，但恢复集合取「被作废的全部
 * 候选」（按令牌去重）：后继快照里含前一批载荷，只取最后一个会把只出现在前者里的
 * 载荷（如派发的 extra）丢掉。
 *
 * 只要回执带着**可信的权威快照**（带服务端 revision），就同时解决**更早**的未决
 * 提交（I7 在受理路径、J1 在冲突/拒绝路径）：账本一旦采信了权威内容，就不能再让
 * 过期 pending 继续当投影和下一笔 set 的载荷——那会用「旧内容 + 新版本」删掉别的
 * 标签页刚入队的条目。没有 revision 的回执（路由层 400 空体）不当权威：不采纳、
 * 也不定论。
 */
export function settleQueueWrite(
  book: QueueBook,
  sessionId: string,
  revision: number,
  disposition: QueueWriteDisposition,
  snapshot?: QueueSnapshot,
): {
  book: QueueBook;
  restore: QueueItemPayload[];
  /** 由权威快照解决、从未被受理、需回到草稿的载荷（I7）。 */
  resolved: QueueItemPayload[];
  uncertain: boolean;
} {
  const entry = queueEntry(book, sessionId);
  if (!entry.pending.some((proposal) => proposal.revision === revision)) {
    // 已被更早的失败连带作废（内容那时已经归还）：不再恢复第二次。
    return { book, restore: [], resolved: [], uncertain: false };
  }
  if (disposition === "unknown") {
    return {
      book: put(book, sessionId, {
        ...entry,
        pending: entry.pending.map((proposal) => (
          proposal.revision === revision ? { ...proposal, state: "uncertain" as const } : proposal
        )),
      }),
      restore: [],
      resolved: [],
      uncertain: true,
    };
  }
  // 「成功」必须带得回权威快照才算数：没有快照就无法证明服务端持有什么，
  // 按结果未知处理比抧测安全（宁可不恢复，也不要复制出重复副本）。
  if (disposition === "accepted") {
    if (!snapshot || snapshot.revision === null) {
      return {
        book: put(book, sessionId, {
          ...entry,
          pending: entry.pending.map((proposal) => (
            proposal.revision === revision ? { ...proposal, state: "uncertain" as const } : proposal
          )),
        }),
        restore: [],
        resolved: [],
        uncertain: true,
      };
    }
    const authority = resolvePendingsAgainstAuthority(book, sessionId, revision, snapshot);
    return { book: authority.book, restore: [], resolved: authority.resolved, uncertain: false };
  }
  // 失败（conflict / rejected）。
  //
  // 「定论」与「采纳」必须同时发生：账本一旦采信了回执里的权威队列（有 revision），
  // 就不能再让更早的未决 pending 继续当投影和下一笔 set 的载荷（J1）——旧行为只丢掉
  // 「本次及其后继」，那个永远待确认的 pending 会把「旧内容 + 新版本」写回去，删掉
  // 别的标签页刚入队的条目。
  const trusted = authoritativeSnapshot(snapshot);
  const adopted = trusted ? adoptServerSnapshot(book, sessionId, trusted) : book;
  const settled = queueEntry(adopted, sessionId);
  const admitted = new Set(trusted?.admittedAttemptIds ?? settled.admittedAttemptIds);
  const seen = new Set<string>();
  const older = trusted
    ? settleUnsettledByAuthority(settled, revision, admitted, seen)
    : { revisions: new Set<number>(), resolved: [] as QueueItemPayload[] };
  const dropped = settled.pending.filter((proposal) => proposal.revision >= revision);
  const restore: QueueItemPayload[] = [];
  for (const proposal of dropped) {
    for (const payload of proposal.candidates) {
      const attemptId = payload.attemptId;
      if (!attemptId || seen.has(attemptId) || admitted.has(attemptId)) continue;
      seen.add(attemptId);
      restore.push(payload);
    }
  }
  const pending = settled.pending.filter(
    (proposal) => proposal.revision < revision && !older.revisions.has(proposal.revision),
  );
  const untouched = adopted === book && pending.length === settled.pending.length;
  return {
    book: untouched ? adopted : put(adopted, sessionId, { ...settled, pending }),
    restore,
    resolved: older.resolved,
    uncertain: false,
  };
}
