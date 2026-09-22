/**
 * 会话栏瞬时态纯模型（无 React / 无 IO / 不写 Pi schema）。
 *
 * 职责边界：
 * - 分组可见条数（show more / show fewer / 搜索全量）
 * - 乐观会话列表合并（server ↔ pending，stale 保护）
 * - 最近会话/置顶会话派生（全量会话，不再按目录过滤：#53 未分组区接管了归属）
 *
 * 树投影仍由 session-sidebar-model 负责；本文件只产出可接入的状态切片。
 */

import type { SessionInfo } from "@/lib/types";

// ── 分组可见条数 ───────────────────────────────────────────────────────────

/** 每个 group key 默认展示的顶层会话节点数。 */
export const DEFAULT_GROUP_VISIBLE_COUNT = 5;
/** 每次「显示更多」递增步长。 */
export const GROUP_VISIBLE_PAGE_SIZE = 5;

/**
 * 读取某分组的可见条数：缺省为默认 5；搜索激活时调用方应改走 getVisibleTopLevelNodes。
 * 本 map 只存用户显式调大后的值，不持久化。
 */
export function getGroupVisibleCount(
  counts: Readonly<Record<string, number>>,
  groupKey: string,
): number {
  const raw = counts[groupKey];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < DEFAULT_GROUP_VISIBLE_COUNT) {
    return DEFAULT_GROUP_VISIBLE_COUNT;
  }
  return Math.floor(raw);
}

/** 显示更多：当前值 +5（未记录过则从默认 5 起算）。 */
export function bumpGroupVisibleCount(
  counts: Readonly<Record<string, number>>,
  groupKey: string,
): Record<string, number> {
  const current = getGroupVisibleCount(counts, groupKey);
  return { ...counts, [groupKey]: current + GROUP_VISIBLE_PAGE_SIZE };
}

/** 显示更少：重置该分组到默认；若本就默认则返回原引用。 */
export function resetGroupVisibleCount(
  counts: Readonly<Record<string, number>>,
  groupKey: string,
): Record<string, number> {
  if (!(groupKey in counts)) return counts as Record<string, number>;
  const next = { ...counts };
  delete next[groupKey];
  return next;
}

/**
 * 从顶层节点列表截取可见窗口。
 * - searchActive：返回全部（引用相等）
 * - 否则取前 N 个顶层节点；每个节点连同其 child tree 完整保留，绝不半截 child
 */
export function getVisibleTopLevelNodes<T>(
  topLevelNodes: readonly T[],
  visibleCount: number,
  searchActive: boolean,
): readonly T[] {
  if (searchActive) return topLevelNodes;
  const n = Math.max(0, Math.floor(visibleCount));
  if (n >= topLevelNodes.length) return topLevelNodes;
  return topLevelNodes.slice(0, n);
}

/** 是否还能「显示更多」：搜索中不显示；否则顶层总数大于当前可见数。 */
export function canShowMoreTopLevel(
  totalTopLevel: number,
  visibleCount: number,
  searchActive: boolean,
): boolean {
  if (searchActive) return false;
  return totalTopLevel > Math.max(0, Math.floor(visibleCount));
}

/** 是否显示「显示更少」：搜索中不显示；否则当前可见数大于默认。 */
export function canShowFewerTopLevel(
  visibleCount: number,
  searchActive: boolean,
): boolean {
  if (searchActive) return false;
  return Math.floor(visibleCount) > DEFAULT_GROUP_VISIBLE_COUNT;
}

// ── 乐观会话合并 ───────────────────────────────────────────────────────────

/**
 * 会话排序：modified 降序；modified 相同则 created 降序；再相同按 id 升序稳定。
 * 与 SessionInfo 的 ISO 字符串字段语义一致（字典序 ≈ 时间序）。
 */
export function compareSessionsByActivity(a: SessionInfo, b: SessionInfo): number {
  const byModified = b.modified.localeCompare(a.modified);
  if (byModified !== 0) return byModified;
  const byCreated = b.created.localeCompare(a.created);
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

export interface MergeOptimisticSessionsInput {
  /** 服务端权威列表（可为空数组）。 */
  serverSessions: readonly SessionInfo[];
  /** 本地乐观/待确认会话（新建未回流等）。 */
  pendingSessions: readonly SessionInfo[];
  /**
   * 仍处于 pending 集合的 id：stale server 响应不得把它们删掉。
   * 缺省时用 pendingSessions 的 id 集合。
   */
  pendingIds?: ReadonlySet<string>;
  /** 用户已显式删除的 id：即使仍在 pending 也移除。 */
  deletedIds?: ReadonlySet<string>;
}

/**
 * 合并 server 列表与 pending 列表：
 * - 同 id：server 条目替换 pending（server 权威）
 * - pending 中 server 没有的 id：保留（乐观插入；stale 保护）
 * - deletedIds 中的 id：两侧均剔除
 * - 结果按 compareSessionsByActivity 稳定排序
 */
export function mergeOptimisticSessions(input: MergeOptimisticSessionsInput): SessionInfo[] {
  const {
    serverSessions,
    pendingSessions,
    pendingIds = new Set(pendingSessions.map((s) => s.id)),
    deletedIds,
  } = input;

  const byId = new Map<string, SessionInfo>();

  // server 权威：同 id 直接写入（覆盖后续不会再写的 pending）
  for (const session of serverSessions) {
    if (deletedIds?.has(session.id)) continue;
    byId.set(session.id, session);
  }

  // stale 保护：仍在 pendingIds 且 server 未带回、未显式删除的，保留 pending 副本
  for (const session of pendingSessions) {
    if (deletedIds?.has(session.id)) continue;
    if (byId.has(session.id)) continue;
    if (!pendingIds.has(session.id)) continue;
    byId.set(session.id, session);
  }

  return [...byId.values()].sort(compareSessionsByActivity);
}

/**
 * 从 pending 集合中移除已出现在 server 列表的 id（回流完成）。
 * 返回新 Set；无变化时返回原引用。
 */
export function reconcilePendingSessionIds(
  pendingIds: ReadonlySet<string>,
  serverSessions: readonly SessionInfo[],
): Set<string> {
  if (pendingIds.size === 0) return pendingIds as Set<string>;
  const serverIds = new Set(serverSessions.map((s) => s.id));
  let changed = false;
  const next = new Set<string>();
  for (const id of pendingIds) {
    if (serverIds.has(id)) {
      changed = true;
      continue;
    }
    next.add(id);
  }
  return changed ? next : (pendingIds as Set<string>);
}

/**
 * 会话列表 fetch 代际：仅当 responseGen === latestGen 时允许写 server/error/loading。
 * 乱序 R1 在 R2 之后返回时必须丢弃。
 */
export function shouldApplySessionListResponse(
  responseGen: number,
  latestGen: number,
): boolean {
  return responseGen === latestGen && responseGen > 0;
}

// ── 最近会话区 ─────────────────────────────────────────────────────────────

/** 最近区候选池上限（按 modified 取最近 N 条）。 */
export const RECENT_SESSIONS_LIMIT = 20;
/** 最近区默认可见条数。 */
export const RECENT_SESSIONS_INITIAL_VISIBLE = 5;
/** 最近区每次「加载更多」追加条数。 */
export const RECENT_SESSIONS_LOAD_MORE = 5;

/** 最近区「显示更多 / 收起」后的可见条数。 */
export function nextRecentVisibleCount(
  current: number,
  total: number,
  action: "more" | "fewer",
): number {
  const totalSafe = Math.max(0, Math.floor(total));
  if (action === "fewer") {
    return Math.min(RECENT_SESSIONS_INITIAL_VISIBLE, totalSafe);
  }
  const cur = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : RECENT_SESSIONS_INITIAL_VISIBLE;
  return Math.min(cur + RECENT_SESSIONS_LOAD_MORE, totalSafe);
}

/** activity 里已有、列表还不认识的子会话：有界补刷，避免同一批 id 永不重试或轮询打爆。 */
export function planSubagentDiscoveryRefresh(input: {
  missingIds: readonly string[];
  lastKey: string;
  attempts: number;
  lastAttemptAt: number;
  now: number;
  maxAttempts?: number;
  cooldownMs?: number;
}): { fire: boolean; lastKey: string; attempts: number; lastAttemptAt: number } {
  const key = [...input.missingIds].filter(Boolean).sort().join(",");
  if (!key) return { fire: false, lastKey: "", attempts: 0, lastAttemptAt: 0 };
  const maxAttempts = input.maxAttempts ?? 3;
  const cooldownMs = input.cooldownMs ?? 4_000;
  if (key !== input.lastKey) {
    return { fire: true, lastKey: key, attempts: 1, lastAttemptAt: input.now };
  }
  if (input.attempts >= maxAttempts) {
    return { fire: false, lastKey: key, attempts: input.attempts, lastAttemptAt: input.lastAttemptAt };
  }
  if (input.now - input.lastAttemptAt < cooldownMs) {
    return { fire: false, lastKey: key, attempts: input.attempts, lastAttemptAt: input.lastAttemptAt };
  }
  return { fire: true, lastKey: key, attempts: input.attempts + 1, lastAttemptAt: input.now };
}

export interface DeriveRecentSessionsInput {
  /** 全量会话列表（服务端 + 乐观合并后）；排序语义由本函数内部保证。 */
  sessions: readonly SessionInfo[];
  /** 附加排除 id（如已删除、仅显示占位等）。 */
  excludeIds?: ReadonlySet<string>;
  /** 展示条数上限；损坏/负数回退默认 RECENT_SESSIONS_LIMIT（20）。 */
  limit?: number;
}

/**
 * 最近会话派生（OpenChamber Recent zone 语义的纯逻辑版）：
 * 按 modified 降序取最近 N 个会话（默认 N=20），作为项目列表上方的纯快捷入口。
 *
 * 排除规则：
 * - subagent 子会话（`session.subagent` 存在）——子会话只读、不参与最近区
 * - `excludeIds` 显式排除的 id
 *
 * 不按目录过滤：不在项目列表里的会话归侧栏底部未分组区，最近区照常显示（#53）。
 * 本函数不修改输入数组；输入是否已排序不影响结果（内部先稳定排序）。
 */
export function deriveRecentSessions(input: DeriveRecentSessionsInput): SessionInfo[] {
  const { sessions, excludeIds, limit = RECENT_SESSIONS_LIMIT } = input;
  const n = Math.max(0, Math.floor(limit));
  const filtered = sessions.filter((s) => {
    if (s.subagent) return false;
    if (excludeIds?.has(s.id)) return false;
    return true;
  });
  const sorted = filtered.slice().sort(compareSessionsByActivity);
  const top = sorted.slice(0, n);
  // fork 子会话在**父行下嵌套**渲染（最近区与项目树同一渲染）：父**也在这段列表里**时，
  // 子不能再单独出一行 —— 否则同一会话会出现两行（一行是它自己、一行嵌在父行下），
  // 而 fork 会连标题一起复制，看起来就像「同一个会话显示了好几行」。
  // 只按「父也在这段列表里」判断，而不是按「父存在」：父不在最近区时子必须自己出列，
  // 否则会话会从最近区凭空消失。
  const visible = new Set(top.map((s) => s.id));
  return top.filter((s) => !(s.parentSessionId && visible.has(s.parentSessionId)));
}

export interface DerivePinnedSessionsInput {
  /** 全量会话列表（服务端 + 乐观合并后）。 */
  sessions: readonly SessionInfo[];
  /** 置顶 id 顺序（最新置顶在前）；结果按此顺序输出。 */
  pinnedSessionIds: readonly string[];
}

/**
 * 置顶会话派生（纯逻辑）：按 pinnedSessionIds 顺序输出仍存在的会话。
 *
 * 排除规则：
 * - 已不在 sessions 中的 id（会话已删除/归档）——静默跳过
 * - subagent 子会话（只读、不参与置顶）
 *
 * 不按目录过滤：置顶是用户显式动作，被置顶的会话一定可见（#53）。
 * 本函数不修改输入数组；不存在/被排除的 id 不报错。
 */
export function derivePinnedSessions(input: DerivePinnedSessionsInput): SessionInfo[] {
  const { sessions, pinnedSessionIds } = input;
  const byId = new Map<string, SessionInfo>();
  for (const s of sessions) {
    if (s.subagent) continue;
    byId.set(s.id, s);
  }
  const pinnedSet = new Set(pinnedSessionIds);
  const result: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const id of pinnedSessionIds) {
    const s = byId.get(id);
    if (!s || seen.has(id)) continue;
    // 与最近区同一条规则：**父也被置顶**时子会话会嵌在父行下，不再单独出一行；
    // 只钉了子会话时必须保留它自己那一行（否则这次置顶就白钉了、会话也不可见）。
    if (s.parentSessionId && pinnedSet.has(s.parentSessionId) && byId.has(s.parentSessionId)) continue;
    seen.add(id);
    result.push(s);
  }
  return result;
}
