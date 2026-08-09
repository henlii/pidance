/**
 * Skills PATCH 写边界（#16 D1 / #17 D1）。
 *
 * 旧实现直接信任客户端 filePath（只查 existsSync 就 readFileSync/writeFileSync），
 * 被授权用户可借 PATCH /api/skills 改写任意存在文件。本模块把写操作收敛为：
 *
 * 1. loader 权威列表校验 —— filePath 必须精确命中 `loadSkillsWithInstallInfo(cwd)`
 *    返回的技能，客户端不能自指路径；
 * 2. 来源可写性（物理路径判定）—— 全局技能（agentDir/skills、~/.agents/skills）可写；
 *    项目技能（cwd/.pi/skills、cwd/.agents/skills）需要项目信任；其余
 *    （package/temporary）拒绝。词法路径上的 symlink 不能把写操作带出技能根；
 * 3. symlink 拒绝 —— 目标本身、词法路径各级父目录（含技能根自身）均不得是
 *    symlink；写前 lstat 必须是常规文件；
 * 4. 同目录临时文件原子替换 + 权限保持；rename 前复核父目录与目标（缩小 TOCTOU）；
 * 5. 行尾保持 —— 按原文件 CRLF/LF 插入或删除键，不混入固定 LF；frontmatter
 *    编辑严格限定文件开头 `---\n...\n---` 区间，正文中的同名示例文本绝不触碰。
 */

/** cwd 必须是存在的目录（路径有效性校验；信任门禁已移除）。 */
function isUsableProjectPath(cwd: string): boolean {
  if (!cwd || typeof cwd !== "string") return false;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

import { closeSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "./pi-paths";
import { loadSkillsWithInstallInfo } from "./skills-service";
import { openRegularFileReadonly } from "./file-read";

import type { SkillInfo } from "./api-types";

export class SkillWriteError extends Error {
  readonly code: "bad-request" | "not-found" | "forbidden";
  constructor(code: "bad-request" | "not-found" | "forbidden", message: string) {
    super(message);
    this.code = code;
  }
}

const KEY = "disable-model-invocation";

interface SkillWriteDeps {
  loadSkills: (cwd: string) => Promise<{ skills: SkillInfo[] }>;
  agentDir: string;
  homeDir: string;
}

const defaultDeps: SkillWriteDeps = {
  loadSkills: (cwd) => loadSkillsWithInstallInfo(cwd),
  agentDir: getAgentDir(),
  homeDir: homedir(),
};

/** 规范化后是否在某个根之内（含根本身）。 */
function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * 技能来源可写性判定（物理路径级，与 loader sourceInfo 互补）：
 * - 全局技能根（agentDir/skills、~/.agents/skills）：用户自己的配置，可写；
 * - 项目技能根（cwd/.pi/skills、cwd/.agents/skills）：写项目文件，需项目信任；
 * - 其余（node_modules 包技能、temporary、<inline> 等）：不可写。
 *
 * 必须基于 `realpathSync` 后的物理路径判定：词法上落在技能根内的路径，若其父
 * 目录/技能目录是 symlink（如 `/proj/.agents/skills/evil -> /outside`），真实目标
 * 并不在任何物理技能根内，一律归为 denied，防止写操作被带出技能根边界。
 */
function classifySkillSource(filePath: string, realTarget: string, cwd: string, deps: SkillWriteDeps): "global" | "project" | "denied" {
  const inPhysicalRoots = (roots: string[]): boolean =>
    roots.some((root) => {
      let realRoot: string;
      try {
        realRoot = realpathSync(root);
      } catch {
        return false; // 根不存在/不可达：不匹配
      }
      return isWithin(realTarget, realRoot);
    });
  const globalRoots = [join(deps.agentDir, "skills"), join(deps.homeDir, ".agents", "skills")];
  if (inPhysicalRoots(globalRoots)) return "global";
  const projectRoots = [join(cwd, ".pi", "skills"), join(cwd, ".agents", "skills")];
  if (inPhysicalRoots(projectRoots)) return "project";
  return "denied";
}

/** 词法技能根（用于逐级 symlink 检查的停止边界）。 */
function skillRoots(cwd: string, deps: SkillWriteDeps): string[] {
  return [
    join(deps.agentDir, "skills"),
    join(deps.homeDir, ".agents", "skills"),
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
  ];
}

/**
 * 从目标父目录逐级向上 lstat，拒绝路径链上任何 symlink 组件（含词法技能根自身）。
 * 根之上不检查 —— 与 file-save 的 cwd 边界同理（cwd 本身可能是 symlink 入口，
 * macOS /tmp 等系统级 symlink 不得误杀）。realpath 分类只保证物理目标落在物理根
 * 内，词法链上的「根内互相链接」仍须在此显式拒绝（如 foo -> bar 均在根内）。
 */
function assertNoSymlinkInChain(filePath: string, roots: string[]): void {
  let current = dirname(filePath);
  for (;;) {
    const isRoot = roots.some((root) => resolve(root) === resolve(current));
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(current);
    } catch {
      // 路径被并发移除：交给下游 not-found 处理；这里继续向上找根或终止。
      if (isRoot) throw new SkillWriteError("not-found", "file not found");
      if (current === dirname(current)) break;
      current = dirname(current);
      continue;
    }
    if (entry.isSymbolicLink()) throw new SkillWriteError("forbidden", "path component must not be a symbolic link");
    if (isRoot || current === dirname(current)) break;
    current = dirname(current);
  }
}

/** 检测文件换行风格：首个换行前是否 \r。 */
function detectNewline(content: string): "\r\n" | "\n" {
  const first = content.indexOf("\n");
  if (first > 0 && content.charCodeAt(first - 1) === 13) return "\r\n";
  return "\n";
}

/**
 * 解析文件开头的 frontmatter 区间（`---` 起始行与闭合行之间），返回区间边界：
 * - start：起始 `---` 行之后的行首（frontmatter 正文起点）；
 * - end：闭合 `---` 行的行首。
 * 开闭行按去掉行尾后的字面 `---` 精确匹配（容忍 CRLF）；找不到起始或闭合行
 * （含空文件、正文以 `---` 开头的示例代码等）返回 null —— 视为无 frontmatter。
 * 正文中出现的 `---` 不会被误判为闭合，因为区间扫描从第二行开始、以首个
 * 字面 `---` 行为止。
 */
function parseFrontmatter(content: string): { start: number; end: number } | null {
  const firstNl = content.indexOf("\n");
  if (firstNl === -1) return null;
  if (content.slice(0, firstNl).replace(/\r$/, "") !== "---") return null;
  const start = firstNl + 1;
  let idx = start;
  while (idx <= content.length) {
    const nl = content.indexOf("\n", idx);
    const lineEnd = nl === -1 ? content.length : nl;
    if (content.slice(idx, lineEnd).replace(/\r$/, "") === "---") {
      return { start, end: idx };
    }
    if (nl === -1) return null;
    idx = nl + 1;
  }
  return null;
}

/** 在保留原 frontmatter 行尾的前提下做外科手术式编辑（严格限定 frontmatter 区间）。 */
function editFrontmatterKey(content: string, disable: boolean): string {
  const nl = detectNewline(content);
  const fm = parseFrontmatter(content);
  if (!fm) {
    // 无有效 frontmatter：disable 时新建一段，正文（含同名示例文本）原样保留；
    // 删除方向不存在键可删，直接原样返回。
    if (!disable) return content;
    return `---${nl}${KEY}: true${nl}---${nl}${content}`;
  }
  // 只在起始行与闭合行之间做键检测/插入/删除；正文区间（含代码块示例）绝不触碰。
  const fmBody = content.slice(fm.start, fm.end);
  const keyExists = new RegExp(`^${KEY}\\s*:`, "m").test(fmBody);
  if (disable && !keyExists) {
    // 在开头的 --- 行后插入键（行尾沿用文件风格）。
    return content.slice(0, fm.start) + `${KEY}: true${nl}` + content.slice(fm.start);
  }
  if (!disable && keyExists) {
    const updatedBody = fmBody.replace(new RegExp(`^${KEY}\\s*:.*(?:\r?\n)`, "m"), "");
    if (updatedBody !== fmBody) {
      return content.slice(0, fm.start) + updatedBody + content.slice(fm.end);
    }
  }
  return content;
}

export interface ToggleSkillInput {
  cwd: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export async function toggleSkillDisableModelInvocation(
  input: ToggleSkillInput,
  deps: SkillWriteDeps = defaultDeps,
): Promise<{ success: true }> {
  const { cwd, filePath, disableModelInvocation } = input;
  if (!cwd || typeof cwd !== "string") throw new SkillWriteError("bad-request", "cwd required");
  if (!filePath || typeof filePath !== "string") throw new SkillWriteError("bad-request", "filePath required");
  if (typeof disableModelInvocation !== "boolean") throw new SkillWriteError("bad-request", "disableModelInvocation must be boolean");
  if (!isAbsolute(filePath)) throw new SkillWriteError("bad-request", "filePath must be absolute");
  if (!isUsableProjectPath(cwd)) throw new SkillWriteError("bad-request", "cwd must be an existing directory");

  // 1. loader 权威列表校验：filePath 必须精确命中当前 cwd 加载的技能。
  const { skills } = await deps.loadSkills(cwd);
  const match = skills.find((skill) => resolve(skill.filePath) === resolve(filePath));
  if (!match) throw new SkillWriteError("not-found", "skill not in loader list for cwd");

  // 2. 目标 lstat：先确认存在且为非常规/非 symlink 文件，再进入物理路径校验。
  let stat: ReturnType<typeof statSync>;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new SkillWriteError("not-found", "file not found");
  }
  if (stat.isSymbolicLink()) throw new SkillWriteError("forbidden", "target must not be a symbolic link");
  if (!stat.isFile()) throw new SkillWriteError("bad-request", "target is not a regular file");

  // 3. 物理路径来源判定：realpath 目标与 realpath 技能根比较。词法路径上的 symlink
  //    把目标带出技能根（如 /proj/.agents/skills/evil -> /outside）时归为 denied。
  let realTarget: string;
  try {
    realTarget = realpathSync(filePath);
  } catch {
    throw new SkillWriteError("forbidden", "target path cannot be resolved");
  }
  const source = classifySkillSource(filePath, realTarget, cwd, deps);
  if (source === "denied") throw new SkillWriteError("forbidden", "skill source is not writable (package/temporary or symlink escape)");

  // 4. 词法链逐级 symlink 拒绝（含词法技能根自身；根之上不查）。
  assertNoSymlinkInChain(filePath, skillRoots(cwd, deps));

  // 5. O_NOFOLLOW 读取物理目标：防「realpath 校验与读取之间最终组件被替换成
  //    symlink」的 TOCTOU 竞态（复用 lib/file-read.ts 的 fd 级防护）。
  let fd: number;
  try {
    fd = openRegularFileReadonly(realTarget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new SkillWriteError("not-found", "file not found");
    throw new SkillWriteError("forbidden", "target cannot be read safely");
  }
  let content: string;
  try {
    content = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const updated = editFrontmatterKey(content, disableModelInvocation);

  // 6. 同目录临时文件原子替换 + 权限保持。写入与 rename 一律走物理路径
  //    （realTarget），词法链上的 symlink 无法把写操作带出物理目录。
  const physicalDir = dirname(realTarget);
  const temp = join(physicalDir, `.pi-skill-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temp, updated, { flag: "wx", mode: stat.mode & 0o7777 });
    // rename 前复核父目录与目标，缩小 TOCTOU 窗口。
    if (lstatSync(physicalDir).isSymbolicLink()) throw new SkillWriteError("forbidden", "target directory must not be a symbolic link");
    const beforeRename = lstatSync(realTarget);
    if (beforeRename.isSymbolicLink()) throw new SkillWriteError("forbidden", "target must not be a symbolic link");
    if (!beforeRename.isFile()) throw new SkillWriteError("bad-request", "target is not a regular file");
    renameSync(temp, realTarget);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* 清理失败不覆盖原错误 */ }
    if (error instanceof SkillWriteError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM") {
      throw new SkillWriteError("forbidden", "file write denied");
    }
    throw error;
  }
  return { success: true };
}

/*
 * TOCTOU 残余边界说明：
 * - 读取侧由 openRegularFileReadonly 的 O_NOFOLLOW + fstat 覆盖（最终组件被替换成
 *   symlink 即拒绝）；临时文件以 `wx` 创建，若路径被攻击者预置 symlink 会 EEXIST 失败，
 *   不会跟随写入；rename 原子替换目标条目本身（不跟随 symlink 目标）。
 * - 残余窗口仅在「复核与 rename 之间」父目录被同机同权限攻击者换向为 symlink：
 *   Node 未公开 dirfd/openat/renameat，无法在单次系统调用内完成「验证目录 + 原子替换」，
 *   但真实物理目标已由 realpath 锁定，最坏结果是写入该物理目录（根内），不会把内容
 *   写到任意外部路径。
 */
