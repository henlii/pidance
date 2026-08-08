/**
 * 自管插件包列表：从 settings.packages + 安装目录列出包并统计资源。
 * 仅依赖 settings-store 与 node:fs，不依赖 @earendil-works/pi-coding-agent
 * 的 DefaultPackageManager / SettingsManager（GET /api/plugins 路径使用）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listDisabledPackageKeys, loadPackages } from "./settings-store";
import type { PackageSourceEntry } from "./settings-store";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginsResponse,
} from "./api-types";

/** 对齐上游 pi 配置目录名（.pi） */
const CONFIG_DIR_NAME = ".pi";

/** npm 源解析：npm:<name> 或 npm:<name>@ver */
const NPM_SPEC_RE = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/;

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function keyFor(source: string, scope: PluginScope): string {
  return `${scope}\0${source}`;
}

/** 解析 npm spec：返回包名与可选版本 */
export function parseNpmSpec(spec: string): { name: string; version?: string } {
  const trimmed = spec.trim();
  const match = trimmed.match(NPM_SPEC_RE);
  if (!match) return { name: trimmed };
  return { name: match[1] ?? trimmed, version: match[2] };
}

export interface PackageInstallInfo {
  /** 安装方式：npm 托管 / git 克隆 / 本地路径 / 未识别 */
  kind: "npm" | "git" | "local" | "unknown";
  /** 已安装的绝对路径（不存在则为 undefined → missing） */
  installedPath?: string;
}

export interface ConfiguredPluginPackage {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  install: PackageInstallInfo;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** 本地路径解析：file: URL、~ 展开、绝对/相对路径（对齐上游 resolvePath） */
function resolveLocalPath(input: string, baseDir: string): string {
  let normalized = input.trim();
  if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // 保留原值，交给后续 resolve
    }
  } else {
    normalized = expandHome(normalized);
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(baseDir, normalized);
}

/**
 * 轻量 git 源 host/path 提取（对齐上游 git/<host>/<path> 安装布局）。
 * 解析失败返回 undefined，调用方据此标 missing。
 */
function parseGitSource(source: string): { host: string; path: string } | undefined {
  let s = source;
  if (s.startsWith("git:")) s = s.slice(4).trim();
  // github:<user>/<repo> 简写
  if (s.startsWith("github:")) {
    const rest = s.slice("github:".length).replace(/\.git$/, "").replace(/\/+$/, "");
    if (!rest || !rest.includes("/")) return undefined;
    return { host: "github.com", path: rest };
  }
  // 先剥 #ref
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) s = s.slice(0, hashIdx);
  // scp-like：git@host:path
  const scpLike = s.match(/^git@([^:]+):(.+)$/);
  if (scpLike) {
    return { host: scpLike[1], path: scpLike[2].replace(/\.git$/, "").replace(/\/+$/, "") };
  }
  // 显式协议 URL：scheme://host/path[@ref]
  const urlMatch = s.match(/^(?:https?|ssh|git):\/\/([^/]+)\/(.+)$/);
  if (urlMatch) {
    const path = urlMatch[2].split("@")[0].replace(/\.git$/, "").replace(/\/+$/, "");
    if (!path) return undefined;
    return { host: urlMatch[1], path };
  }
  // 裸 host/path 形式（host 需含 . 或为 localhost）
  const slash = s.indexOf("/");
  if (slash > 0) {
    const host = s.slice(0, slash);
    const path = s.slice(slash + 1).split("@")[0].replace(/\.git$/, "").replace(/\/+$/, "");
    if (path && (host.includes(".") || host === "localhost")) {
      return { host, path };
    }
  }
  return undefined;
}

/** 非本地源判断（对齐上游 isLocalPath：npm:/git:/github:/http:/https:/ssh: 均为远程） */
function isRemoteSource(source: string): boolean {
  const trimmed = source.trim();
  return (
    trimmed.startsWith("npm:") ||
    trimmed.startsWith("git:") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("http:") ||
    trimmed.startsWith("https:") ||
    trimmed.startsWith("ssh:")
  );
}

/**
 * 计算包的安装路径（对齐 package-manager.js getInstalledPath）：
 * - npm: <agentDir>/npm/node_modules/<name>（global）/ <cwd>/.pi/npm/node_modules/<name>（project）
 * - git: <agentDir>/git/<host>/<path>（global）/ <cwd>/.pi/git/<host>/<path>（project）
 * - local: resolve 后 exists 则用
 */
export function getInstalledPath(
  source: string,
  scope: "global" | "project",
  options: { agentDir: string; cwd?: string },
): PackageInstallInfo {
  const trimmed = source.trim();
  const baseDirForScope = (): string =>
    scope === "project" ? resolve(options.cwd ?? "", CONFIG_DIR_NAME) : resolve(options.agentDir);
  if (trimmed.startsWith("npm:")) {
    const { name } = parseNpmSpec(trimmed.slice(4));
    const path = join(baseDirForScope(), "npm", "node_modules", name);
    return { kind: "npm", installedPath: existsSync(path) ? path : undefined };
  }
  if (!isRemoteSource(trimmed)) {
    // 本地路径：resolve 后存在则用
    const path = resolveLocalPath(trimmed, baseDirForScope());
    return { kind: "local", installedPath: existsSync(path) ? path : undefined };
  }
  // git 及其它远程源：尽力解析 host/path；解析失败标 missing
  const parsed = parseGitSource(trimmed);
  if (parsed) {
    const path = join(baseDirForScope(), "git", parsed.host, parsed.path);
    return { kind: "git", installedPath: existsSync(path) ? path : undefined };
  }
  return { kind: "git" };
}

function isFileEntry(dir: string, entry: Dirent): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isFile();
  } catch {
    return false;
  }
}

function isDirEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function readDirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function shouldSkip(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** 扩展资源：递归收集 .ts/.js 文件（跳过点文件/node_modules；index.ts 命名在 getResourceName 中归为目录） */
function collectExtensionFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readDirSafe(dir)) {
    if (shouldSkip(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (isFileEntry(dir, entry)) {
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) out.push(fullPath);
    } else if (isDirEntry(dir, entry)) {
      collectExtensionFiles(fullPath, out);
    }
  }
}

/** skill 资源：目录含 SKILL.md 计 1（找到即不深入）；否则根目录直接 .md 与递归子目录 */
function collectSkillFiles(dir: string, root: string, out: string[]): void {
  if (!existsSync(dir)) return;
  const entries = readDirSafe(dir);
  // 第一遍：本目录的 SKILL.md
  for (const entry of entries) {
    if (entry.name === "SKILL.md" && isFileEntry(dir, entry)) {
      out.push(join(dir, entry.name));
      return;
    }
  }
  // 第二遍：根目录直接 .md + 递归子目录
  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (isFileEntry(dir, entry) && dir === root && entry.name.endsWith(".md")) {
      out.push(fullPath);
    } else if (isDirEntry(dir, entry)) {
      collectSkillFiles(fullPath, root, out);
    }
  }
}

/** prompts/themes 资源：按扩展名递归收集（对齐上游 FILE_PATTERNS） */
function collectFilesByPattern(dir: string, pattern: RegExp, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readDirSafe(dir)) {
    if (shouldSkip(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (isFileEntry(dir, entry)) {
      if (pattern.test(entry.name)) out.push(fullPath);
    } else if (isDirEntry(dir, entry)) {
      collectFilesByPattern(fullPath, pattern, out);
    }
  }
}

export interface ScannedPackageResources {
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
}

function getResourceName(path: string, kind: PluginResourceKind): string {
  const file = basename(path);
  const ext = extname(file);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if ((kind === "extension" || kind === "theme" || kind === "prompt") && ext) {
    if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
    return file.slice(0, -ext.length);
  }
  return file;
}

function getRelativePath(path: string, baseDir: string): string {
  const rel = relative(baseDir, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** 扫描已安装包目录的资源：extensions/skills/prompts/themes 计数与列表 */
export function scanPackageResources(installedPath: string): ScannedPackageResources {
  const counts = emptyCounts();
  const resources: PluginResourceInfo[] = [];
  const add = (kind: PluginResourceKind, files: string[]): void => {
    const countKey =
      kind === "extension" ? "extensions" : kind === "skill" ? "skills" : kind === "prompt" ? "prompts" : "themes";
    for (const path of files) {
      counts[countKey] += 1;
      resources.push({
        kind,
        name: getResourceName(path, kind),
        path,
        relativePath: getRelativePath(path, installedPath),
      });
    }
  };
  const extensions: string[] = [];
  collectExtensionFiles(installedPath, extensions);
  const skills: string[] = [];
  collectSkillFiles(installedPath, installedPath, skills);
  const prompts: string[] = [];
  collectFilesByPattern(installedPath, /\.md$/, prompts);
  const themes: string[] = [];
  collectFilesByPattern(installedPath, /\.json$/, themes);
  add("extension", extensions);
  add("skill", skills);
  add("prompt", prompts);
  add("theme", themes);
  return { counts, resources };
}

function readPackageMetadata(installedPath?: string): { packageName?: string; version?: string } {
  if (!installedPath) return {};
  try {
    const stats = statSync(installedPath);
    const packageJsonPath = stats.isDirectory()
      ? join(installedPath, "package.json")
      : join(dirname(installedPath), "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      packageName: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  } catch {
    return {};
  }
}

function getConfiguredVersion(source: string): string | undefined {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) return parseNpmSpec(trimmed.slice(4)).version;
  if (trimmed.startsWith("git:") || /^[a-z]+:\/\//.test(trimmed)) {
    const lastAt = trimmed.lastIndexOf("@");
    const lastSlash = trimmed.lastIndexOf("/");
    const lastColon = trimmed.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return trimmed.slice(lastAt + 1) || undefined;
  }
  return undefined;
}

export interface ListPluginPackagesOptions {
  agentDir: string;
  cwd?: string;
}

/** 列出配置的包（global + 存在 cwd 时的 project） */
export function listConfiguredPackages(options: ListPluginPackagesOptions): ConfiguredPluginPackage[] {
  const result: ConfiguredPluginPackage[] = [];
  const push = (entry: PackageSourceEntry, scope: PluginScope): void => {
    const source = typeof entry === "string" ? entry : entry.source;
    result.push({
      source,
      scope,
      filtered: typeof entry === "object",
      install: getInstalledPath(source, scope === "project" ? "project" : "global", options),
    });
  };
  for (const entry of loadPackages("global", { agentDir: options.agentDir })) push(entry, "global");
  if (options.cwd) {
    for (const entry of loadPackages("project", { agentDir: options.agentDir, cwd: options.cwd })) {
      push(entry, "project");
    }
  }
  return result;
}

/**
 * 自管插件列表（readPlugins 等价实现）：
 * 对每个配置包计算安装路径、资源计数与状态；missing 包 push warning diagnostic。
 */
export function listPluginPackages(options: ListPluginPackagesOptions): PluginsResponse {
  const disabledByPackage = listDisabledPackageKeys({ agentDir: options.agentDir, cwd: options.cwd });
  const diagnostics: PluginDiagnostic[] = [];
  const totals = emptyCounts();
  const packages: PluginPackageInfo[] = listConfiguredPackages(options).map((pkg) => {
    const key = keyFor(pkg.source, pkg.scope);
    const disabled = disabledByPackage.get(key) ?? false;
    let counts = emptyCounts();
    let resources: PluginResourceInfo[] = [];
    if (pkg.install.installedPath) {
      const scanned = scanPackageResources(pkg.install.installedPath);
      counts = scanned.counts;
      resources = scanned.resources;
      for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
        totals[kind] += counts[kind];
      }
    } else {
      diagnostics.push({
        type: "warning",
        source: pkg.source,
        message: "Configured package path was not found.",
      });
    }
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(pkg.install.installedPath);
    return {
      source: pkg.source,
      scope: pkg.scope,
      filtered: pkg.filtered,
      disabled,
      installedPath: pkg.install.installedPath,
      packageName: packageMetadata.packageName,
      version: packageMetadata.version,
      configuredVersion: getConfiguredVersion(pkg.source),
      counts,
      resources,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : pkg.install.installedPath ? "installed" : "missing",
    } satisfies PluginPackageInfo;
  });
  return { packages, totals, diagnostics };
}
