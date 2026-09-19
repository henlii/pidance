/**
 * 项目信任同步（`~/.pi/agent/trust.json`）。
 *
 * 为什么要写它：Pidance 主 Agent 走同进程 SDK，创建服务时不传 settingsManager，
 * SDK 因此按默认 `projectTrusted = true` 处理 —— 项目级 `.pi/*` 与祖先
 * `.agents/skills` 无条件加载。但 subagent 走的是 `pi` CLI 子进程（pi-subagents），
 * CLI 会真的做信任判定：cwd 存在需要信任的项目资源、trust.json 里又没有条目时是
 * `ask`，而子进程没有 UI，于是判成 false —— 子代理里项目技能/扩展整体缺失，
 * 和主 Agent 不一致。
 *
 * 所以：侧栏「加入项目」写 `true`，「关闭项目」（= 从项目列表移除）撤销，两边口径
 * 一致。分支工作树同样
 * 处理（它建在仓库旁：`<repo>-worktrees/<branch>`，不是仓库子目录，拿不到项目那条
 * 祖先条目），创建时写、删除时撤。
 *
 * 写入必须走 SDK 的 `ProjectTrustStore`：它和 pi CLI 用同一把 proper-lockfile 锁，
 * 自己读写 JSON 会和终端里正在跑的 pi 并发写互相覆盖。
 *
 * 有意的边界：
 * - 列表里的项目一律写**自己的精确条目**（即使祖先条目已经给 true）：信任列表与
 *   侧栏项目一一对应，关闭项目时删掉的就是它自己那条。祖先条目的继承效果是 Pi 的
 *   查找规则（最近祖先生效），不在本模块里做 `false` 覆盖。
 * - 信任面 = 侧栏项目列表（`projectRoots`）∪ 分支工作树；列表之外的会话 cwd 与临时
 *   目录不写，避免把信任面铺开。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./pi-paths";

/** trust.json 里是否有该路径的**精确**条目（不沿祖先查找）。 */
function hasExactTrustEntry(root: string, agentDir: string): boolean {
  const path = join(agentDir, "trust.json");
  if (!existsSync(path)) return false;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    data = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  let canonical = root;
  try {
    canonical = realpathSync(root);
  } catch {
    // 目录已不在（关闭后删除/重命名）：退回原样比较，匹配不到就当没有条目。
  }
  return data[canonical] === true || data[root] === true;
}

export interface ProjectTrustSyncPlan {
  /** 需要写入 `true` 的项目根 */
  trust: string[];
  /** 需要删除精确条目的项目根 */
  revoke: string[];
}

export interface ProjectTrustSyncResult {
  trusted: number;
  revoked: number;
  /** 写入失败的项目根（偏好写入不受影响，调用方只记日志） */
  failed: string[];
}

/** 偏好里的路径列表：只接受非空字符串，去重保序。 */
function asPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function prefRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 取侧栏偏好里的项目根列表。
 *
 * 客户端把侧栏偏好（含 projectRoots）整体放在 `sidebarUi` 这个键下同步
 * （见 lib/ui-preferences.ts 的 sidebarUiFromPrefs），顶层同名字段只是兼容/测试形态。
 */
function sidebarRoots(record: Record<string, unknown>, key: string): string[] {
  const nested = prefRecord(record.sidebarUi);
  return asPathList(nested[key] !== undefined ? nested[key] : record[key]);
}

/**
 * 比较写入前后的偏好，算出要同步的项目信任。
 *
 * - 列表里的每个项目 → 确保受信（已受信的不重写）；新增项目、以及本功能上线前的
 *   旧项目都会在任意一次偏好写入时补齐。
 * - 从列表里消失的项目（关闭项目）→ 撤销。
 */
export function planProjectTrustSync(prev: unknown, next: unknown): ProjectTrustSyncPlan {
  const before = new Set(sidebarRoots(prefRecord(prev), "projectRoots"));
  const after = sidebarRoots(prefRecord(next), "projectRoots");
  const keeping = new Set(after);
  return {
    trust: after,
    revoke: [...before].filter((root) => !keeping.has(root)),
  };
}

/**
 * 全量计划（服务启动时用）：按偏好现状把列表里的项目拉齐为受信。
 *
 * 没有「之前的列表」可比，所以不产生撤销项——关闭动作总是发生在服务运行期间，
 * 由 planProjectTrustSync 的差量覆盖。
 */
export function planProjectTrustBackfill(prefs: unknown): ProjectTrustSyncPlan {
  return { trust: sidebarRoots(prefRecord(prefs), "projectRoots"), revoke: [] };
}

/**
 * 写入 `true`（信任列表与项目一一对应：祖先已给 true 也写自己那条）。
 * 已有精确条目时不重写。返回是否真的写了。
 */
export function trustProjectRoot(root: string, agentDir: string = getAgentDir()): boolean {
  if (!isWritableRoot(root)) return false;
  if (hasExactTrustEntry(root, agentDir)) return false;
  new ProjectTrustStore(agentDir).set(root, true);
  return true;
}

/** 撤销：删掉该路径的精确条目（关闭项目 = 从信任列表移除）。返回是否发起了删除。 */
export function revokeProjectTrust(root: string, agentDir: string = getAgentDir()): boolean {
  if (!isWritableRoot(root)) return false;
  if (!hasExactTrustEntry(root, agentDir)) return false;
  new ProjectTrustStore(agentDir).set(root, null);
  return true;
}

/**
 * 空/非法路径一律不写：`resolvePath("")` 会落到进程 cwd，凭空信任一个目录。
 * 计划函数已经过滤过，这里是写入边界的第二道兜底。
 */
function isWritableRoot(root: unknown): root is string {
  return typeof root === "string" && root.trim().length > 0;
}

/** 执行同步计划。单个路径失败只记录，不影响其余路径与偏好写入。 */
export function applyProjectTrustSync(
  plan: ProjectTrustSyncPlan,
  agentDir: string = getAgentDir(),
): ProjectTrustSyncResult {
  const result: ProjectTrustSyncResult = { trusted: 0, revoked: 0, failed: [] };
  for (const root of plan.trust) {
    if (!isWritableRoot(root)) continue;
    try {
      if (trustProjectRoot(root, agentDir)) result.trusted += 1;
    } catch (error) {
      result.failed.push(root);
      console.warn(`[pidance] failed to trust project ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const root of plan.revoke) {
    if (!isWritableRoot(root)) continue;
    try {
      if (revokeProjectTrust(root, agentDir)) result.revoked += 1;
    } catch (error) {
      result.failed.push(root);
      console.warn(`[pidance] failed to revoke project trust ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/**
 * 偏好写入后的信任同步（供 /api/preferences 调用）。
 *
 * 信任是副产物：这里兜住所有异常，绝不让偏好写入返回错误，也不重复写
 * trust.json（计划为空时直接返回）。
 */
export function syncProjectTrustFromPrefs(
  prev: unknown,
  next: unknown,
  agentDir: string = getAgentDir(),
): ProjectTrustSyncResult {
  return runTrustSync(() => planProjectTrustSync(prev, next), agentDir);
}

/**
 * 启动时按当前偏好把信任面拉齐（补齐旧项目、清掉关闭项遗留）。
 *
 * 幂等：已受信的根不重写；只有真的变了才记一行日志。
 */
export function syncProjectTrustBackfill(
  prefs: unknown,
  agentDir: string = getAgentDir(),
): ProjectTrustSyncResult {
  return runTrustSync(() => planProjectTrustBackfill(prefs), agentDir);
}

function runTrustSync(
  planFor: () => ProjectTrustSyncPlan,
  agentDir: string,
): ProjectTrustSyncResult {
  try {
    const plan = planFor();
    if (plan.trust.length === 0 && plan.revoke.length === 0) {
      return { trusted: 0, revoked: 0, failed: [] };
    }
    return applyProjectTrustSync(plan, agentDir);
  } catch (error) {
    console.warn(`[pidance] project trust sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return { trusted: 0, revoked: 0, failed: [] };
  }
}
