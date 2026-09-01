/**
 * Pidance → pi-subagents 的 pi CLI 桥接。
 *
 * 目标态：主 Agent 用同进程 SDK；subagent 使用同一发布依赖
 * `package.json#bin.pi` 声明的 CLI。
 *
 * 解析基于 process.cwd() 向上查找 node_modules，不使用 import.meta.url，
 * 避免把构建机绝对路径嵌入 webpack 产物。
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** pi-subagents 读取的环境变量名。 */
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

function isRunnableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveDeclaredPiCli(packageRoot: string): string | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null) return null;
    const bin = (manifest as { bin?: unknown }).bin;
    const declared = typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null && !Array.isArray(bin)
        ? (bin as Record<string, unknown>).pi
        : null;
    if (typeof declared !== "string" || !declared.trim()) return null;

    const candidate = resolve(packageRoot, declared);
    const packageRelative = relative(packageRoot, candidate);
    if (
      !packageRelative
      || packageRelative === ".."
      || packageRelative.startsWith(`..${sep}`)
      || isAbsolute(packageRelative)
    ) {
      return null;
    }
    return isRunnableFile(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * 从 startDir 向上查找包内 Pi CLI。
 */
export function resolvePackagePiCli(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const packageRoot = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    const candidate = resolveDeclaredPiCli(packageRoot);
    if (candidate) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 兼容旧名：优先包内 CLI，其次显式 PI_SUBAGENT / PIDANCE_PI_RUNTIME。
 */
export function resolvePidancePiCli(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string | null {
  const explicit =
    env[PI_SUBAGENT_PI_BINARY_ENV]?.trim() || env.PIDANCE_PI_RUNTIME?.trim();
  if (explicit && isRunnableFile(explicit)) return explicit;
  return resolvePackagePiCli(startDir);
}

/**
 * 设置 PI_SUBAGENT_PI_BINARY 指向包内 Pi CLI。
 */
export function configurePiSubagentBinaryFromPackage(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string | null {
  if (process.platform === "win32") return null;
  const cli = resolvePackagePiCli(startDir);
  if (!cli) return null;
  process.env[PI_SUBAGENT_PI_BINARY_ENV] = cli;
  // 保留 env 参数语义：若调用方传入自定义 env 对象则同步写回
  if (env !== process.env) {
    env[PI_SUBAGENT_PI_BINARY_ENV] = cli;
  }
  return cli;
}

/** @deprecated 使用 configurePiSubagentBinaryFromPackage */
export function configurePiSubagentBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return configurePiSubagentBinaryFromPackage(env);
}
