import { listAllSessions } from "./session-reader";
import { mutatePidancePrefs, readPidancePrefs } from "./pidance-prefs-file";
import {
  UNREAD_SESSION_STATE_KEY,
  parseUnreadSessionState,
  pruneUnreadSessionState,
  type UnreadSessionState,
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

/**
 * 两条与并发/环境有关的硬约束（审查发现，别删）：
 *
 * 1. **落盘必须在锁内重读。** 扫会话目录是锁外的慢操作（数百 ms），这期间另一进程
 *    （31415/31416 共用 agent dir）或另一次 run 结束可能刚写进一条 `completedAt`、
 *    客户端 PUT 可能刚合并进 `readAt`、删除路径可能刚清掉某个键。`unreadSessionState`
 *    是**整对象**键（`setByDottedKey` 整体替换），拿锁外快照整桶写回去会把它们全盖掉 ——
 *    所以只从锁内读到的**最新**桶里删「仍然不可见、且时间戳仍然过期」的 id。
 * 2. **空会话列表一律放弃本轮。** `lib/session-metadata-cache.ts` 的 readdir 失败会
 *    `return []`，与「真的没有会话」无法区分；误判的代价是把全部旧未读清掉。与
 *    `instrumentation.ts` 的附件回收同口径：集合读不完整就放弃。
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
  /**
   * 会话列表来源（缺省走 `listAllSessions()`）。注入只为测试。
   * 返回**空列表**会被当成「集合读不完整」而放弃本轮（见模块 doc 第 2 条）—— 测试要给非空列表。
   */
  listSessions?: () => Promise<ReadonlyArray<{ id: string; subagent?: unknown }>>;
}

export interface UnreadEntrySweepResult {
  /** 本轮被清掉的会话 id。 */
  swept: string[];
  /** 本轮被跳过：节流、上一轮还在跑，或会话列表为空（保险丝，见模块 doc 第 2 条）。 */
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
 * 测试用：是否有一轮回收正在跑。
 *
 * 「回收在执行中」会让新的触发直接跳过，而回收是 fire-and-forget 的 —— 上一个用例
 * 遗留的那一轮可能还在飞（它扫的是已被删掉的临时目录），下一个用例的触发就会被跳过。
 * 用例要在触发前把在途的那一轮等干净（上一个用例的目录还在时就等）。
 */
export function isUnreadEntrySweepInFlightForTests(): boolean {
  return sweepInFlight;
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

/** 某个 id 的最近一次活动（completedAt 与 readAt 取较晚者）；都不可解析返回 NaN。 */
function latestUnreadAt(state: UnreadSessionState, id: string): number {
  const completed = parseTimestamp(state.completedAt[id]);
  const read = parseTimestamp(state.readAt[id]);
  if (Number.isNaN(completed)) return read;
  if (Number.isNaN(read)) return completed;
  return Math.max(completed, read);
}

/**
 * 回收 `unreadSessionState` 里不会再被显示的条目。被节流，可以安全地在热路径上 fire-and-forget。
 *
 * 返回值只用于日志与测试。**它可能抛**（会话列表/偏好写入的异常不吞）：调用方负责 catch，
 * 本轮不重试；节流时间戳在 await 之前就占住，所以下一次触发最多等 `minIntervalMs`
 * —— 这是有意的：热路径（每次 run 结束）上不能因为持续失败就反复扫会话目录。
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
    // 快路径：没有任何未读时钟时不必扫会话目录（回收只在有候选时才可能写盘）。
    const snapshot = parseUnreadSessionState(readPidancePrefs(deps.agentDir)[UNREAD_SESSION_STATE_KEY]);
    const candidates = new Set([...Object.keys(snapshot.completedAt), ...Object.keys(snapshot.readAt)]);
    if (candidates.size === 0) return { swept: [], skipped: false };

    const sessions = await (deps.listSessions ?? listAllSessions)();
    // 保险丝：空列表可能是「真的没有会话」，也可能是目录读失败（根目录缺失/不可读、
    // PI_CODING_AGENT_DIR 指错 —— lib/session-metadata-cache.ts:128 的 readdir 失败一律 return []）。
    // 两者无法区分，而误判会清掉全部旧未读，所以空列表一律放弃本轮、不写盘。
    if (sessions.length === 0) return { swept: [], skipped: true };

    const visible = visibleUnreadSessionIds(sessions);
    const cutoff = now - (deps.minAgeMs ?? UNREAD_SWEEP_MIN_AGE_MS);
    const worthChecking = [...candidates].filter((id) => !visible.has(id));
    if (worthChecking.length === 0) return { swept: [], skipped: false };

    // 锁内重读（见模块 doc 第 1 条）：候选与可见集合来自锁外，真正删谁由**最新**桶决定。
    const swept: string[] = [];
    mutatePidancePrefs((prefs) => {
      const fresh = parseUnreadSessionState(prefs[UNREAD_SESSION_STATE_KEY]);
      const keep = new Set([...Object.keys(fresh.completedAt), ...Object.keys(fresh.readAt)]);
      const doomed: string[] = [];
      for (const id of worthChecking) {
        if (doomed.length >= (deps.maxEntries ?? UNREAD_SWEEP_MAX_ENTRIES)) break;
        if (!keep.has(id)) continue; // 锁窗口里已被别的路径清掉（例如 clearDeletedSessionPrefs）
        // 时间戳在锁窗口里被刷新过 → 说明这条还没过期（宽限期重算），留着。
        const latest = latestUnreadAt(fresh, id);
        if (!Number.isNaN(latest) && latest > cutoff) continue;
        keep.delete(id);
        doomed.push(id);
      }
      if (doomed.length === 0) return false;
      // 复用客户端同一份剪枝实现：给它的集合是「要保留的 id」，它会丢掉其余的。
      const next = pruneUnreadSessionState(fresh, keep);
      if (next === fresh) return false;
      prefs[UNREAD_SESSION_STATE_KEY] = next;
      swept.push(...doomed);
      return true;
    }, deps.agentDir);
    return { swept, skipped: false };
  } finally {
    sweepInFlight = false;
  }
}
