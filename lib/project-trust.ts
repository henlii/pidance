/**
 * 项目信任的服务端边界：把 Pi 的 `trust.json` 存储与 `defaultProjectTrust`
 * 设置接到 Deck，判定顺序由 `project-trust-model.ts` 的纯函数负责。
 *
 * 自管 trust.json / settings.json（不依赖 pi npm 的 ProjectTrustStore /
 * SettingsManager）；写入经本地 ProjectTrustStore（原子写 + schema 校验）。
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "./pi-paths";
import { getAllowedFileRoots, isFilePathAllowed } from "./file-access";
import { readDefaultProjectTrustFromDisk } from "./settings-store";
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "./trust-store";
import {
  buildProjectTrustUpdates,
  decideProjectTrust,
  type DefaultProjectTrustSetting,
  type ProjectTrustChoice,
  type ProjectTrustDecisionList,
  type ProjectTrustDecisionRecord,
  type ProjectTrustEntryInfo,
  type ProjectTrustStatus,
} from "./project-trust-model";

export type {
  ProjectTrustChoice,
  ProjectTrustDecisionList,
  ProjectTrustDecisionRecord,
  ProjectTrustStatus,
} from "./project-trust-model";

/**
 * 与 SDK `canonicalizePath(resolvePath(cwd))` 对齐：先 resolve 再 realpath。
 * realpath 失败（路径不存在等）时退回 resolve 结果，保证纯字符串比较仍可用。
 */
export function canonicalizeProjectPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** cwd 的父目录；已在根目录时返回 null（与 SDK `getProjectTrustParentPath` 同义）。 */
export function getProjectTrustParent(cwd: string): string | null {
  const canonical = canonicalizeProjectPath(cwd);
  const parent = dirname(canonical);
  return parent === canonical ? null : parent;
}

/** 读取全局 `defaultProjectTrust`（只读 settings.json，不加载项目 settings）。 */
function readDefaultProjectTrust(agentDir: string): DefaultProjectTrustSetting {
  return readDefaultProjectTrustFromDisk(agentDir);
}

function readTrustEntry(agentDir: string, canonicalCwd: string): ProjectTrustEntryInfo | null {
  try {
    const store = new ProjectTrustStore(agentDir);
    const entry = store.getEntry(canonicalCwd);
    return entry ? { path: entry.path, decision: entry.decision } : null;
  } catch {
    // trust.json 损坏或被锁：按「无记录」处理，即降级为不信任而非误信任。
    return null;
  }
}

/** 解析某个 cwd 的完整信任状态（只读，不写 trust.json）。 */
export function getProjectTrustStatus(cwd: string, agentDirOverride?: string): ProjectTrustStatus {
  const agentDir = agentDirOverride ?? getAgentDir();
  const canonicalCwd = canonicalizeProjectPath(cwd);
  let requiresTrust = false;
  try {
    requiresTrust = hasTrustRequiringProjectResources(canonicalCwd);
  } catch {
    // 探测失败时按需要信任处理，宁可多问一次也不要静默加载项目资源。
    requiresTrust = true;
  }
  return decideProjectTrust({
    cwd: canonicalCwd,
    requiresTrust,
    entry: readTrustEntry(agentDir, canonicalCwd),
    defaultProjectTrust: readDefaultProjectTrust(agentDir),
  });
}

/** 会话创建时使用的最终布尔值，等价于 Pi 传给 SettingsManager 的 `projectTrusted`。 */
export function resolveProjectTrustedForSession(cwd: string, agentDirOverride?: string): boolean {
  try {
    return getProjectTrustStatus(cwd, agentDirOverride).trusted;
  } catch {
    // 任何意外都取 Pi 在无 UI 时的保守结果：不信任。
    return false;
  }
}

/** 持久化一次用户决策，返回写入后的最新状态。 */
export function applyProjectTrustChoice(
  cwd: string,
  choice: ProjectTrustChoice,
  agentDirOverride?: string,
): ProjectTrustStatus {
  const agentDir = agentDirOverride ?? getAgentDir();
  const canonicalCwd = canonicalizeProjectPath(cwd);
  const updates = buildProjectTrustUpdates(canonicalCwd, getProjectTrustParent(canonicalCwd), choice);
  new ProjectTrustStore(agentDir).setMany(updates);
  return getProjectTrustStatus(canonicalCwd, agentDir);
}

/**
 * 只读列出 trust.json 的全部决策，供设置页展示。
 * 直接读文件而不经 ProjectTrustStore：store 没有列举 API，且它的读路径会
 * 先创建目录再加锁，只为展示不值得产生副作用。解析规则与 Pi 保持一致。
 */
export function listProjectTrustDecisions(agentDirOverride?: string): ProjectTrustDecisionList {
  const agentDir = agentDirOverride ?? getAgentDir();
  const defaultProjectTrust = readDefaultProjectTrust(agentDir);
  const trustPath = join(resolve(agentDir), "trust.json");
  if (!existsSync(trustPath)) return { decisions: [], defaultProjectTrust };
  try {
    const parsed: unknown = JSON.parse(readFileSync(trustPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { decisions: [], defaultProjectTrust, error: "trust.json 不是对象" };
    }
    const decisions: ProjectTrustDecisionRecord[] = [];
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 与 SDK readTrustFile 对齐：只允许 true / false / null；其它类型整文件视为损坏。
      if (value !== true && value !== false && value !== null) {
        return {
          decisions: [],
          defaultProjectTrust,
          error: `trust.json 中路径 ${JSON.stringify(path)} 的值必须是 true、false 或 null`,
        };
      }
      // Pi 允许 null（表示已清除），展示时跳过。
      if (value === true || value === false) decisions.push({ path, decision: value });
    }
    decisions.sort((a, b) => a.path.localeCompare(b.path));
    return { decisions, defaultProjectTrust };
  } catch (error) {
    return { decisions: [], defaultProjectTrust, error: String(error) };
  }
}

/** 校验来自 HTTP 的 cwd：必须是存在的目录，拒绝文件与不存在路径。 */
export function isUsableProjectPath(cwd: string): boolean {
  if (!cwd || typeof cwd !== "string") return false;
  try {
    return statSync(canonicalizeProjectPath(cwd)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 允许根门禁：canonical cwd 必须落在 getAllowedFileRoots() 内。
 * 调用方应先用 isUsableProjectPath 确认是存在的目录，再调本函数。
 * 使用 isFilePathAllowed 的路径段比较，避免仅字符串前缀相似的旁路
 * （例如允许 `/proj` 时拒绝 `/proj-evil`）。
 */
export async function isAllowedProjectCwd(cwd: string): Promise<boolean> {
  const allowedRoots = await getAllowedFileRoots();
  return isFilePathAllowed(canonicalizeProjectPath(cwd), allowedRoots);
}
