/**
 * Pidance 外部 Pi 运行时目录配置（服务端持久化）。
 * 文件：~/.pi/agent/pidance-runtime.json（与 Pi agent 目录同根，非 Pi 原生 schema）。
 * runtimeDir 留空 = 使用 PATH 中的 pi；非空 = 在该目录下解析 pi 二进制。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "./pi-paths";

export const RUNTIME_CONFIG_VERSION = 1 as const;
export const RUNTIME_CONFIG_FILE = "pidance-runtime.json";

export type PidanceRuntimeConfig = {
  version: typeof RUNTIME_CONFIG_VERSION;
  /** 运行时根目录；空字符串表示使用 PATH */
  runtimeDir: string;
};

export type RuntimeConfigFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  statSync: (path: string) => { isDirectory(): boolean };
};

const defaultFs: RuntimeConfigFs = {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
};

export function runtimeConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, RUNTIME_CONFIG_FILE);
}

export function defaultRuntimeConfig(): PidanceRuntimeConfig {
  return { version: RUNTIME_CONFIG_VERSION, runtimeDir: "" };
}

export function normalizeRuntimeDir(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  return trimmed;
}

/**
 * 校验用户配置的目录：空 = PATH；非空须绝对路径且存在为目录。
 */
export function validateRuntimeDir(
  runtimeDir: string,
  fsImpl: RuntimeConfigFs = defaultFs,
): { ok: true; runtimeDir: string } | { ok: false; message: string } {
  const dir = normalizeRuntimeDir(runtimeDir);
  if (!dir) return { ok: true, runtimeDir: "" };
  if (!isAbsolute(dir)) {
    return { ok: false, message: "运行时目录须为绝对路径（留空则使用 PATH）" };
  }
  const finalPath = resolve(dir);
  try {
    if (!fsImpl.existsSync(finalPath)) {
      return { ok: false, message: `目录不存在：${finalPath}` };
    }
    if (!fsImpl.statSync(finalPath).isDirectory()) {
      return { ok: false, message: `不是目录：${finalPath}` };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, runtimeDir: finalPath };
}

export function readRuntimeConfig(
  agentDir: string = getAgentDir(),
  fsImpl: RuntimeConfigFs = defaultFs,
): PidanceRuntimeConfig {
  const path = runtimeConfigPath(agentDir);
  try {
    if (!fsImpl.existsSync(path)) return defaultRuntimeConfig();
    const raw = JSON.parse(fsImpl.readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultRuntimeConfig();
    const rec = raw as Record<string, unknown>;
    return {
      version: RUNTIME_CONFIG_VERSION,
      runtimeDir: normalizeRuntimeDir(rec.runtimeDir),
    };
  } catch {
    return defaultRuntimeConfig();
  }
}

export function writeRuntimeConfig(
  config: PidanceRuntimeConfig,
  agentDir: string = getAgentDir(),
  fsImpl: RuntimeConfigFs = defaultFs,
): PidanceRuntimeConfig {
  const path = runtimeConfigPath(agentDir);
  const dir = dirname(path);
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  const payload: PidanceRuntimeConfig = {
    version: RUNTIME_CONFIG_VERSION,
    runtimeDir: normalizeRuntimeDir(config.runtimeDir),
  };
  const tmp = `${path}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fsImpl.renameSync(tmp, path);
  return payload;
}

/**
 * 在目录下查找 pi 可执行入口（bin/pi、pi、dist/cli.js、包内 cli）。
 */
export function findPiBinaryInDir(
  runtimeDir: string,
  isRunnable: (path: string) => boolean,
): string | null {
  const dir = normalizeRuntimeDir(runtimeDir);
  if (!dir) return null;
  const root = resolve(dir);
  const candidates = [
    join(root, "bin", "pi"),
    join(root, "pi"),
    join(root, "dist", "cli.js"),
    join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    // 若用户直接填 package 根（含 package.json name=pi-coding-agent）
    join(root, "cli.js"),
  ];
  for (const c of candidates) {
    if (isRunnable(c)) return resolve(c);
  }
  return null;
}
