/**
 * 外部 Pi runtime 二进制解析。
 *
 * 顺序（与迁移规格一致）：
 * 1. PIDANCE_PI_RUNTIME 绝对路径（管理员显式）
 * 2. PATH 中的 `pi`
 * 3. 可选 fallback：Pidance 自带 node_modules CLI（仅当
 *    PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED=1，默认关闭——不把 bundled 当可升级引擎）
 *
 * 主 runtime 与 PI_SUBAGENT_PI_BINARY 应同源；见 configureRuntimeEnv。
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export type RuntimeBinarySource =
  | "configured-path"
  | "path"
  | "bundled-fallback"
  | "none";

export type ResolvedRuntimeBinary = {
  path: string | null;
  source: RuntimeBinarySource;
  version: string | null;
};

const RELATIVE_CLI = join(
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);

function isRunnableFile(candidate: string): boolean {
  try {
    const st = statSync(candidate);
    if (!st.isFile()) return false;
    accessSync(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isRunnableFile(candidate)) return resolve(candidate);
  }
  return null;
}

function findBundledCli(): string | null {
  let dir = resolve(process.cwd());
  for (let level = 0; level < 12 && dir !== dirname(dir); level++) {
    const candidate = join(dir, RELATIVE_CLI);
    if (isRunnableFile(candidate)) return resolve(candidate);
    dir = dirname(dir);
  }
  return null;
}

/** 读 `pi --version`；失败返回 null。 */
export function readPiVersion(binaryPath: string, timeoutMs = 5000): string | null {
  try {
    // cli.js 需 node 执行；带 shebang 的 pi 可直接执行
    const isJs = binaryPath.endsWith(".js");
    const out = isJs
      ? execFileSync(process.execPath, [binaryPath, "--version"], {
          encoding: "utf8",
          timeout: timeoutMs,
          env: process.env,
        })
      : execFileSync(binaryPath, ["--version"], {
          encoding: "utf8",
          timeout: timeoutMs,
          env: process.env,
        });
    const line = String(out).trim().split(/\r?\n/)[0]?.trim() ?? "";
    // 接受 "0.81.1" 或 "pi 0.81.1"
    const m = line.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    return m?.[1] ?? (line || null);
  } catch {
    return null;
  }
}

export function resolveRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeBinary {
  const configured = env.PIDANCE_PI_RUNTIME?.trim();
  if (configured) {
    const abs = isAbsolute(configured) ? configured : resolve(configured);
    if (isRunnableFile(abs) || existsSync(abs)) {
      return {
        path: abs,
        source: "configured-path",
        version: readPiVersion(abs),
      };
    }
  }

  // 托管 slot：~/.pidance/runtimes/pi/current（若存在）
  // 动态 import 会异步；此处用同步探测 current 目录约定，避免与 runtime-upgrade 循环依赖
  {
    const home = env.HOME || "";
    const slotsRoot =
      env.PIDANCE_PI_RUNTIME_SLOTS_DIR?.trim() ||
      (home ? join(home, ".pidance", "runtimes", "pi") : "");
    if (slotsRoot) {
      const currentLink = join(slotsRoot, "current");
      const candidates = [
        join(currentLink, "bin", "pi"),
        join(currentLink, "pi"),
        join(currentLink, "dist", "cli.js"),
        join(
          currentLink,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        ),
      ];
      for (const candidate of candidates) {
        if (isRunnableFile(candidate)) {
          // 版本取 current 指向的目录名（若可 realpath）
          let version: string | null = null;
          try {
            const real = resolve(candidate);
            const m = real.match(/[/\\](\d+\.\d+\.\d+(?:-[\w.]+)?)[/\\]/);
            version = m?.[1] ?? null;
          } catch {
            version = null;
          }
          return {
            path: resolve(candidate),
            source: "configured-path",
            version: version ?? readPiVersion(candidate),
          };
        }
      }
    }
  }

  const onPath = findOnPath("pi", env.PATH ?? "");
  if (onPath) {
    return {
      path: onPath,
      source: "path",
      version: readPiVersion(onPath),
    };
  }

  if (env.PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED === "1") {
    const bundled = findBundledCli();
    if (bundled) {
      return {
        path: bundled,
        source: "bundled-fallback",
        version: readPiVersion(bundled),
      };
    }
  }

  return { path: null, source: "none", version: null };
}

/**
 * 将解析到的 runtime 写入 PI_SUBAGENT_PI_BINARY，保证 subagent 与主 runtime 同源。
 * 未解析到时不改动已有 env。
 */
export function configureRuntimeEnv(env: NodeJS.ProcessEnv = process.env): ResolvedRuntimeBinary {
  const resolved = resolveRuntimeBinary(env);
  if (resolved.path) {
    env.PI_SUBAGENT_PI_BINARY = resolved.path;
  }
  return resolved;
}

/**
 * Agent 运行模式。
 * 默认 **rpc**（只用外部 pi）；仅当显式 `PIDANCE_AGENT_RUNTIME=inprocess` 才走进程内 SDK。
 */
export function getAgentRuntimeMode(
  env: NodeJS.ProcessEnv = process.env,
): "inprocess" | "rpc" {
  const raw = (env.PIDANCE_AGENT_RUNTIME ?? "rpc").trim().toLowerCase();
  return raw === "inprocess" ? "inprocess" : "rpc";
}
