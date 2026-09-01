/**
 * 自管插件包 install/remove/update（不依赖 @earendil-works/pi-coding-agent）。
 * 仅支持 npm: 源；通过 child_process.execFile 调用系统 npm（不用 shell），
 * settings 持久化走 settings-store。语义对齐上游 package-manager.js 的
 * DefaultPackageManager 简化版：
 * - 安装根：global → <agentDir>/npm；project → <cwd>/.pi/npm
 * - settings 匹配按包身份（npm:<name>，忽略版本）
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import type { PluginScope } from "./api-types";
import { parseNpmSpec } from "./plugin-packages";
import { loadPackages, savePackages } from "./settings-store";
import type { PackageSourceEntry } from "./settings-store";

/** npm 命令二进制名（Windows 上 execFile 需要 .cmd 后缀） */
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

/** systemd/精简 PATH 经常没有 npm；优先用当前 Node 旁边的 npm。 */
export function resolveNpmBin(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  const fromEnv = env.npm_execpath?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const sibling = join(dirname(execPath), NPM_BIN);
  if (existsSync(sibling)) return sibling;
  return NPM_BIN;
}

/** npm 子进程超时：120s（对齐任务约定） */
const NPM_TIMEOUT_MS = 120_000;

/** 项目配置目录名（对齐 plugin-packages.ts 的 CONFIG_DIR_NAME） */
const PROJECT_CONFIG_DIR = ".pi";

/** 非 npm: 源不被支持时抛出（route 层据此返回 400「暂不支持」） */
export class PluginUnsupportedSourceError extends Error {}

/** npm 子进程执行接口（测试可注入 mock runner） */
export interface PluginExecRunner {
  execFile(
    file: string,
    args: string[],
    options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }>;
}

const execFileAsync = promisify(execFileCb) as PluginExecRunner["execFile"];

/** 默认 runner：真实调用系统 npm */
export const defaultPluginExecRunner: PluginExecRunner = {
  execFile: (file, args, options) => execFileAsync(file, args, options),
};

export interface PluginInstallOptions {
  agentDir: string;
  cwd?: string;
  /** 注入 runner 便于测试（默认真实 npm） */
  runner?: PluginExecRunner;
}

/** 校验并提取 npm spec（非 npm: 源抛 PluginUnsupportedSourceError） */
export function requireNpmSource(source: string): { spec: string; name: string; version?: string } {
  const trimmed = source.trim();
  if (!trimmed.startsWith("npm:")) {
    throw new PluginUnsupportedSourceError(`暂不支持的插件源（仅支持 npm:）：${source}`);
  }
  const spec = trimmed.slice("npm:".length).trim();
  const { name, version } = parseNpmSpec(spec);
  return { spec, name, version };
}

/** 安装根目录：global → <agentDir>/npm；project → <cwd>/.pi/npm（对齐上游 getNpmInstallRoot） */
export function getNpmInstallRoot(
  scope: PluginScope,
  options: { agentDir: string; cwd?: string },
): string {
  return scope === "project"
    ? join(resolve(options.cwd ?? ""), PROJECT_CONFIG_DIR, "npm")
    : join(resolve(options.agentDir), "npm");
}

/** 确保安装根存在 package.json（对齐上游 ensureNpmProject） */
export function ensureNpmProject(installRoot: string): void {
  if (!existsSync(installRoot)) mkdirSync(installRoot, { recursive: true });
  const packageJsonPath = join(installRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "pi-extensions", private: true }, null, 2),
      "utf8",
    );
  }
}

function packageSourceOf(entry: PackageSourceEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

/** 包身份匹配键：npm 包按 npm:<name>（忽略版本，对齐上游 getPackageIdentity） */
function matchKeyOf(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const { name } = parseNpmSpec(trimmed.slice("npm:".length).trim());
    return `npm:${name}`;
  }
  return trimmed;
}

/**
 * 追加/更新包 entry 到 settings（对齐上游 addSourceToSettings）：
 * 不存在则 push；存在同身份 entry 则更新其 source（保留 object 过滤信息）。
 * @returns 是否改动了列表
 */
export function addPackageToSettings(
  source: string,
  scope: PluginScope,
  options: { agentDir: string; cwd?: string },
): boolean {
  const key = matchKeyOf(source);
  const current = loadPackages(scope, options);
  const matchIndex = current.findIndex((entry) => matchKeyOf(packageSourceOf(entry)) === key);
  if (matchIndex !== -1) {
    const existing = current[matchIndex];
    if (packageSourceOf(existing) === source) return false;
    const next = [...current];
    next[matchIndex] = typeof existing === "string" ? source : { ...existing, source };
    savePackages(scope, next, options);
    return true;
  }
  savePackages(scope, [...current, source], options);
  return true;
}

/** 从 settings 移除所有匹配身份包 entry（对齐上游 removeSourceFromSettings） */
export function removePackageFromSettings(
  source: string,
  scope: PluginScope,
  options: { agentDir: string; cwd?: string },
): boolean {
  const key = matchKeyOf(source);
  const current = loadPackages(scope, options);
  const next = current.filter((entry) => matchKeyOf(packageSourceOf(entry)) !== key);
  if (next.length === current.length) return false;
  savePackages(scope, next, options);
  return true;
}

/** 在 settings 中查找与 source 同身份的已配置源字符串（update 用；无匹配返回 undefined） */
export function findMatchingNpmSource(
  source: string,
  scope: PluginScope,
  options: { agentDir: string; cwd?: string },
): string | undefined {
  const key = matchKeyOf(source);
  for (const entry of loadPackages(scope, options)) {
    if (matchKeyOf(packageSourceOf(entry)) === key) return packageSourceOf(entry);
  }
  return undefined;
}

/** npm install 参数：install <spec> --prefix <root> --legacy-peer-deps */
export function buildInstallArgs(spec: string, installRoot: string): string[] {
  return ["install", spec, "--prefix", installRoot, "--legacy-peer-deps"];
}

/** npm uninstall 参数：uninstall <name> --prefix <root> --legacy-peer-deps */
export function buildUninstallArgs(name: string, installRoot: string): string[] {
  return ["uninstall", name, "--prefix", installRoot, "--legacy-peer-deps"];
}

/** npm update 参数（复用 install 语义：install <spec> --prefix <root> --legacy-peer-deps） */
export function buildUpdateArgs(spec: string, installRoot: string): string[] {
  return ["install", spec, "--prefix", installRoot, "--legacy-peer-deps"];
}

async function runNpm(
  runner: PluginExecRunner,
  args: string[],
  installRoot: string,
): Promise<void> {
  const npmBin = resolveNpmBin();
  const pathPrefix = dirname(npmBin === NPM_BIN ? process.execPath : npmBin);
  const env = {
    ...process.env,
    PATH: `${pathPrefix}${delimiter}${process.env.PATH ?? ""}`,
  };
  await runner.execFile(npmBin, args, { cwd: installRoot, timeout: NPM_TIMEOUT_MS, env });
}

/** 安装 npm 包并持久化到 settings */
export async function installPluginPackage(
  source: string,
  scope: PluginScope,
  options: PluginInstallOptions,
): Promise<void> {
  const { spec } = requireNpmSource(source);
  const runner = options.runner ?? defaultPluginExecRunner;
  const installRoot = getNpmInstallRoot(scope, options);
  ensureNpmProject(installRoot);
  await runNpm(runner, buildInstallArgs(spec, installRoot), installRoot);
  addPackageToSettings(source, scope, options);
}

/** 卸载 npm 包并从 settings 移除（安装根不存在时仅清理 settings，对齐上游 uninstallNpm） */
export async function removePluginPackage(
  source: string,
  scope: PluginScope,
  options: PluginInstallOptions,
): Promise<void> {
  const { name } = requireNpmSource(source);
  const runner = options.runner ?? defaultPluginExecRunner;
  const installRoot = getNpmInstallRoot(scope, options);
  if (existsSync(installRoot)) {
    await runNpm(runner, buildUninstallArgs(name, installRoot), installRoot);
  }
  removePackageFromSettings(source, scope, options);
}

/**
 * 更新 settings 中匹配身份的 npm 包（无匹配抛清晰错误）。
 * 对齐上游 updateNpmBatch：pinned 版本按原 spec 重装，否则升到 <name>@latest。
 * update 不改写 settings（保留原 source，后续仍可匹配）。
 */
export async function updatePluginPackage(
  source: string,
  scope: PluginScope,
  options: PluginInstallOptions,
): Promise<void> {
  const { name } = requireNpmSource(source);
  const configured = findMatchingNpmSource(source, scope, options);
  if (!configured) {
    throw new Error(
      `未在${scope === "project" ? "项目" : "全局"}配置中找到匹配的插件包：${source}`,
    );
  }
  const runner = options.runner ?? defaultPluginExecRunner;
  const installRoot = getNpmInstallRoot(scope, options);
  ensureNpmProject(installRoot);
  const configuredSpec = configured.startsWith("npm:")
    ? configured.slice("npm:".length).trim()
    : "";
  const spec = parseNpmSpec(configuredSpec).version ? configuredSpec : `${name}@latest`;
  await runNpm(runner, buildUpdateArgs(spec, installRoot), installRoot);
}
