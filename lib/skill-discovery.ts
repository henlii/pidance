/**
 * 技能自管发现（替代 DefaultResourceLoader 的 skills 部分，纯磁盘扫描）。
 *
 * 本模块不依赖 @earendil-works/pi-coding-agent，行为对齐 pi skills.js 的简化版：
 *
 * 扫描根（按序合并去重，先扫描到的同名技能优先）：
 * 1. <agentDir>/skills
 * 2. <homeDir>/.agents/skills
 * 3. 若 projectTrusted：<cwd>/.pi/skills、<cwd>/.agents/skills，
 *    以及从 cwd 向上到 git 仓库根（或文件系统根）的祖先 .agents/skills
 *    （排除用户全局 ~/.agents/skills，避免与第 2 条重复扫描）
 * 4. settings.json 的 skills 数组若为路径列表：额外扫描这些路径（文件或目录，
 *    相对路径按 cwd 解析）
 * 5. settings.packages 中的包技能：最小实现暂不扫描（见下方简化说明）
 *
 * 简化说明（相对 pi skills.js / DefaultResourceLoader）：
 * - 不依赖 ignore 包：省略 .gitignore/.ignore 规则。扫描根都是专用技能目录，
 *   被 .gitignore 排除的文件仍会出现，实际影响极小；
 * - package skills（settings.packages / <agentDir>/npm/node_modules）不扫描：
 *   DefaultResourceLoader 需经 DefaultPackageManager 解析包与 enabled 过滤，
 *   本模块保持纯磁盘。若后续需要，可对含 SKILL.md 的包目录直接
 *   loadSkillsFromDir；
 * - settings.json 的旧对象格式（{ customDirectories: [...] }）按 pi 的迁移
 *   语义兼容读取。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Dirent } from "node:fs";
import type { SkillInfo } from "./api-types";

export interface SkillDiscoveryDiagnostic {
  type: string;
  message: string;
  path?: string;
}

export interface SkillDiscoveryResult {
  skills: SkillInfo[];
  diagnostics: SkillDiscoveryDiagnostic[];
}

export interface SkillDiscoveryOptions {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  /** 用户 home 目录，测试时可注入；缺省 homedir()。 */
  homeDir?: string;
}

type SkillScope = "user" | "project";

/** 递归深度上限，防止 symlink 目录环导致无限递归。 */
const MAX_DEPTH = 16;

/** 判断物理/词法路径是否落在某个根之内（含根本身）。 */
function isUnderPath(target: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  if (target === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return target.startsWith(prefix);
}

/** 从 startDir 向上收集祖先 <dir>/.agents/skills，直到 git 仓库根或文件系统根，排除用户全局。 */
function collectAncestorAgentsSkillDirs(startDir: string, homeDir: string): string[] {
  const dirs: string[] = [];
  const userAgentsSkills = resolve(join(homeDir, ".agents", "skills"));
  let dir = resolve(startDir);
  const gitRepoRoot = findGitRepoRoot(dir);
  for (;;) {
    const candidate = join(dir, ".agents", "skills");
    if (resolve(candidate) !== userAgentsSkills) dirs.push(candidate);
    if (gitRepoRoot && dir === gitRepoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function findGitRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 简易 YAML frontmatter 解析：取文件开头 `---` 与闭合 `---` 之间的行，
 * 逐行匹配 `key: value`（多行值/列表等复杂 YAML 不支持，按单行值处理）。
 * 无有效 frontmatter 时返回空对象。
 */
function parseSimpleFrontmatter(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  if (!lines[0] || lines[0].replace(/\r$/, "") !== "---") return fields;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line === "---") break; // 闭合行
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

/** name 缺省：SKILL.md 用父目录名，其余 .md 用文件 basename（去扩展名）。 */
function defaultSkillName(filePath: string): string {
  if (basename(filePath).toLowerCase() === "skill.md") return basename(dirname(filePath));
  const base = basename(filePath);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/** disable-model-invocation：值为 true / "true"（不区分大小写）时为 true。 */
function parseDisableModelInvocation(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim().toLowerCase() === "true";
}

function loadSkillFromFile(filePath: string, scope: SkillScope): { skill: SkillInfo | null; diagnostics: SkillDiscoveryDiagnostic[] } {
  const diagnostics: SkillDiscoveryDiagnostic[] = [];
  try {
    const raw = readFileSync(filePath, "utf8");
    const fm = parseSimpleFrontmatter(raw);
    const baseDir = dirname(filePath);
    const skill: SkillInfo = {
      name: fm.name || defaultSkillName(filePath),
      description: fm.description ?? "",
      filePath,
      baseDir,
      disableModelInvocation: parseDisableModelInvocation(fm["disable-model-invocation"]),
      sourceInfo: { source: "local", scope },
    };
    return { skill, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill file";
    diagnostics.push({ type: "warning", message, path: filePath });
    return { skill: null, diagnostics };
  }
}

/** 条目是否为常规文件（symlink 用 stat 跟随，坏链返回 false）。 */
function isRegularFile(entry: Dirent, fullPath: string): boolean {
  if (entry.isFile()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return statSync(fullPath).isFile();
    } catch {
      return false; // 坏链跳过
    }
  }
  return false;
}

/**
 * 从单个目录加载技能：
 * - 目录含 SKILL.md：当作单一技能根，加载后不再递归；
 * - 否则：加载根下直接 .md 子文件，并递归子目录找 SKILL.md；
 * - 跳过 `.` 开头与 node_modules；symlink 目录用 stat 跟随，坏链跳过；
 * - seen 记录已访问的真实目录，防止 symlink 目录环。
 */
function loadSkillsFromDir(dir: string, scope: SkillScope, seen?: Set<string>, depth = 0): SkillDiscoveryResult {
  const visited = seen ?? new Set<string>();
  if (depth > MAX_DEPTH) return { skills: [], diagnostics: [] };
  try {
    const realDir = realpathSync(dir);
    if (visited.has(realDir)) return { skills: [], diagnostics: [] };
    visited.add(realDir);
  } catch {
    // 目录不存在/不可达：交给 readdirSync 统一跳过
  }

  const skills: SkillInfo[] = [];
  const diagnostics: SkillDiscoveryDiagnostic[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, diagnostics }; // 目录缺失/不可读：安全空态
  }

  // 1. 目录含 SKILL.md：单一技能根，不递归。
  const skillMd = entries.find((entry) => entry.name === "SKILL.md");
  if (skillMd) {
    const fullPath = join(dir, "SKILL.md");
    if (isRegularFile(skillMd, fullPath)) {
      const result = loadSkillFromFile(fullPath, scope);
      if (result.skill) skills.push(result.skill);
      diagnostics.push(...result.diagnostics);
    }
    return { skills, diagnostics };
  }

  // 2. 否则：直接 .md 子文件 + 递归子目录。
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(fullPath);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // 坏链跳过
      }
    }
    if (isDirectory) {
      const sub = loadSkillsFromDir(fullPath, scope, visited, depth + 1);
      skills.push(...sub.skills);
      diagnostics.push(...sub.diagnostics);
    } else if (isFile && entry.name.endsWith(".md")) {
      const result = loadSkillFromFile(fullPath, scope);
      if (result.skill) skills.push(result.skill);
      diagnostics.push(...result.diagnostics);
    }
  }
  return { skills, diagnostics };
}

/** 读取 settings.json 的 skills 数组（兼容旧对象格式 customDirectories）。 */
function readSettingsSkills(settingsPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { skills?: unknown };
    const skills = parsed.skills;
    if (Array.isArray(skills)) return skills.filter((p): p is string => typeof p === "string");
    if (skills && typeof skills === "object" && !Array.isArray(skills)) {
      const custom = (skills as { customDirectories?: unknown }).customDirectories;
      if (Array.isArray(custom)) return custom.filter((p): p is string => typeof p === "string");
    }
  } catch {
    // settings.json 缺失/损坏：忽略
  }
  return [];
}

/**
 * 从全部配置位置发现技能。同名碰撞保留先扫描到的，并为失败者添加
 * collision 诊断；同一物理文件（含 symlink 别名）只保留一份。
 */
export function discoverSkills(options: SkillDiscoveryOptions): SkillDiscoveryResult {
  const { cwd, agentDir, projectTrusted } = options;
  const homeDir = options.homeDir ?? homedir();

  const userRoots = [join(agentDir, "skills"), join(homeDir, ".agents", "skills")];
  const projectRoots: string[] = [];
  if (projectTrusted) {
    projectRoots.push(join(cwd, ".pi", "skills"), join(cwd, ".agents", "skills"));
    projectRoots.push(...collectAncestorAgentsSkillDirs(cwd, homeDir));
  }

  const skillMap = new Map<string, SkillInfo>();
  const realPathSet = new Set<string>();
  const diagnostics: SkillDiscoveryDiagnostic[] = [];

  const addResult = (result: SkillDiscoveryResult) => {
    diagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      let realPath: string;
      try {
        realPath = realpathSync(skill.filePath);
      } catch {
        realPath = resolve(skill.filePath);
      }
      if (realPathSet.has(realPath)) continue; // 同一物理文件（symlink 别名/重复根）跳过
      const existing = skillMap.get(skill.name);
      if (existing) {
        diagnostics.push({
          type: "collision",
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
        });
        continue; // 保留先扫描到的
      }
      skillMap.set(skill.name, skill);
      realPathSet.add(realPath);
    }
  };

  // 1-3. 默认扫描根（先 user 后 project，保证全局技能优先）。
  for (const root of [...userRoots, ...projectRoots]) {
    const scope: SkillScope = userRoots.some((userRoot) => resolve(userRoot) === resolve(root)) ? "user" : "project";
    addResult(loadSkillsFromDir(root, scope));
  }

  // 4. settings.json 的 skills 路径列表（文件或目录）。
  for (const rawPath of readSettingsSkills(join(agentDir, "settings.json"))) {
    const resolved = resolve(cwd, rawPath);
    if (!existsSync(resolved)) {
      diagnostics.push({ type: "warning", message: "skill path does not exist", path: resolved });
      continue;
    }
    try {
      const st = statSync(resolved);
      const scope: SkillScope = userRoots.some((root) => isUnderPath(resolved, root)) ? "user" : "project";
      if (st.isDirectory()) {
        addResult(loadSkillsFromDir(resolved, scope));
      } else if (st.isFile() && resolved.endsWith(".md")) {
        const result = loadSkillFromFile(resolved, scope);
        addResult({ skills: result.skill ? [result.skill] : [], diagnostics: result.diagnostics });
      } else {
        diagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolved });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read skill path";
      diagnostics.push({ type: "warning", message, path: resolved });
    }
  }

  return { skills: Array.from(skillMap.values()), diagnostics };
}
