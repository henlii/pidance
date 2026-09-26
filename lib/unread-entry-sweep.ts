import { listAllSessions } from "./session-reader";
import { readPidancePrefs, updatePidancePref } from "./pidance-prefs-file";
import {
  UNREAD_SESSION_STATE_KEY,
  parseUnreadSessionState,
  pruneUnreadSessionState,
} from "./unread-sessions-storage";

/**
 * 未读时钟的「死条目回收」。
 *
 * `unreadSessionState` 只由两处维护：run 结束时写 `completedAt`（lib/live-session-registry），
 * 以及删除会话时由 `clearDeletedSessionPrefs` 清掉**经它删的**那一条。于是两类条目会永远留下：
 *
 * - **被删掉的会话**：测试/清理脚本、以及「运行中被删」的会话（删除时那条 run 还在跑，
 *   下一次 run 结束差分仍会把它写回来）。本机实测先后出现过 3 条指向磁盘上已不存在会话的死条目。
 * - **子代理子会话**：它们的未读永远不会被消费 —— 侧栏用
 *   `components/session-sidebar/sections.tsx` 的 `isUnread={!node.session.subagent && …}`
 *   显示未读，带 subagent 标记的会话（在顶栏「子会话谱系」里）恒不显示未读，用户也就永远清不掉。
 *
 * 这里的判据直接抄客户端那条规则（**侧栏会不会显示它的未读**），而不是按 id 前缀或文件名猜：
 * 只有「本轮会话列表里存在，且没有 subagent 标记」的 id 才保留条目。列表缺了 31415/31416 另一侧
 * 正在跑的会话？两侧共用同一个 agent dir，列表是同一份，不受影响。
 *
 * 回收本身**不改任何显示语义**：被清掉的条目按客户端规则本来也不显示。
 */

/** 两次回收之间的最小间隔（惰性触发，别每次 run 结束都扫一遍会话目录）。 */
export const UNREAD_SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** 单次最多回收多少条（上限；剩下的留给下一轮）。 */
export const UNREAD_SWEEP_MAX_ENTRIES = 200;
/**
 * 只回收「最后一次活动早于这么久」的条目。
 *
 * 目录扫描拿到的是一份快照，而写入是随时随地发生的：正在跑、或刚跑完的会话可能还没进列表，
 * 若立刻回收就会把刚写下的未读丢掉。给一个宽限期，这个竞态就只剩「5 分钟内被删的会话
 * 要多留一条到下一轮」，代价远小于误删未读。
 */
export const UNREAD_SWEEP_MIN_AGE_MS = 5 * 60 * 1000;

export interface UnreadEntrySweepDeps {
  /** 缺省用当前 agent dir（`getAgentDir()`，即 `PI_CODING_AGENT_DIR` 或 ~/.pi/agent）。 */
  agentDir?: string;
  now?: number;
  minIntervalMs?: number;
  minAgeMs?: number;
  maxEntries?: number;
  /** 会话列表来源（缺省走 `listAllSessions()`）。注入只为测试。 */
  listSessions?: () => Promise<ReadonlyArray<{ id: string; subagent?: unknown }>>;
}

export interface UnreadEntrySweepResult {
  /** 本轮被清掉的会话 id。 */
  swept: string[];
  /** 因节流或正在执行而跳过本轮。 */
  skipped: boolean;
}

let lastSweepAt = 0;
let sweepInFlight = false;

/** 测试用：复位节流与执行中标记。 */
export function resetUnreadEntrySweepForTests(): void {
  lastSweepAt = 0;
  sweepInFlight = false;
}

/**
 * 侧栏「会显示未读」的会话 id。
 *
 * 与 `components/session-sidebar/sections.tsx` 的 `isUnread={!node.session.subagent && …}` 同口径：
 * 子代理子会话在列表里**是存在的**（谱系里能看到），但恒不显示未读。
 */
function visibleUnreadSessionIds(
  sessions: ReadonlyArray<{ id: string; subagent?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.id && !session.subagent) ids.add(session.id);
  }
  return ids;
}

/** 解析一个 ISO 时间戳；无法解析（旧数据/手改）返回 NaN。 */
function parseTimestamp(value: string | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/**
 * 回收 `unreadSessionState` 里不会再被显示的条目。被节流，可以安全地在热路径上 fire-and-forget。
 *
 * 返回值只用于日志与测试；失败不抛（调用方也不需要处理）。
 */
export async function sweepStaleUnreadEntries(
  deps: UnreadEntrySweepDeps = {},
): Promise<UnreadEntrySweepResult> {
  const now = deps.now ?? Date.now();
  const minInterval = deps.minIntervalMs ?? UNREAD_SWEEP_MIN_INTERVAL_MS;
  if (sweepInFlight) return { swept: [], skipped: true };
  // 先占住时间戳再 await：同一时段内的重复触发不该各扫一遍目录。
  if (now - lastSweepAt < minInterval) return { swept: [], skipped: true };
  lastSweepAt = now;
  sweepInFlight = true;
  try {
    const state = parseUnreadSessionState(readPidancePrefs(deps.agentDir)[UNREAD_SESSION_STATE_KEY]);
    const candidates = new Set([...Object.keys(state.completedAt), ...Object.keys(state.readAt)]);
    if (candidates.size === 0) return { swept: [], skipped: false };

    const sessions = await (deps.listSessions ?? listAllSessions)();
    const visible = visibleUnreadSessionIds(sessions);
    const cutoff = now - (deps.minAgeMs ?? UNREAD_SWEEP_MIN_AGE_MS);

    const dead: string[] = [];
    for (const id of candidates) {
      if (visible.has(id)) continue;
      // 取该 id 的最近一次活动：只要还在宽限期内就先留着（见 UNREAD_SWEEP_MIN_AGE_MS）。
      const completed = parseTimestamp(state.completedAt[id]);
      const read = parseTimestamp(state.readAt[id]);
      const latest = Number.isNaN(completed)
        ? read
        : Number.isNaN(read)
          ? completed
          : Math.max(completed, read);
      if (!Number.isNaN(latest) && latest > cutoff) continue;
      dead.push(id);
    }
    if (dead.length === 0) return { swept: [], skipped: false };

    const doomed = new Set(dead.slice(0, deps.maxEntries ?? UNREAD_SWEEP_MAX_ENTRIES));
    // 复用客户端同一份剪枝实现：给它的集合是「要保留的 id」，它会丢掉其余的。
    const keep = new Set([...candidates].filter((id) => !doomed.has(id)));
    const next = pruneUnreadSessionState(state, keep);
    if (next === state) return { swept: [], skipped: false };
    updatePidancePref(UNREAD_SESSION_STATE_KEY, next, deps.agentDir);
    return { swept: [...doomed], skipped: false };
  } finally {
    sweepInFlight = false;
  }
}
