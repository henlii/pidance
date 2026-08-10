/**
 * 一键安装最新外部 Pi 到 npm 全局，并尽量让 Pidance 解析到它。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeRuntimeConfig } from "../pidance-runtime-config";
import { configureRuntimeEnv, resolveRuntimeBinary, type ResolvedRuntimeBinary } from "./resolve-binary";

const execFileAsync = promisify(execFile);

export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
export const DEFAULT_PI_NPM_REGISTRY = "https://registry.npmjs.org/";

export type InstallPiResult = {
  ok: boolean;
  message: string;
  version: string | null;
  path: string | null;
  source: ResolvedRuntimeBinary["source"] | "none";
  npmRoot: string | null;
};

function getRegistry(env: NodeJS.ProcessEnv): string {
  const raw = (env.PIDANCE_NPM_REGISTRY || env.npm_config_registry || DEFAULT_PI_NPM_REGISTRY).trim();
  if (!raw) return DEFAULT_PI_NPM_REGISTRY;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** 从 npm root -g 推导 pi-coding-agent 包目录 */
export function packageDirFromNpmRoot(npmRoot: string): string {
  return join(npmRoot, "@earendil-works", "pi-coding-agent");
}

export async function installLatestPiGlobal(options?: {
  env?: NodeJS.ProcessEnv;
  execFileImpl?: typeof execFileAsync;
  /** 安装后是否把 runtimeDir 指到全局包目录（PATH 已含 npm bin 时可 false） */
  pinRuntimeDir?: boolean;
}): Promise<InstallPiResult> {
  const env = options?.env ?? process.env;
  const exec = options?.execFileImpl ?? execFileAsync;
  const registry = getRegistry(env);

  try {
    await exec(
      "npm",
      [
        "install",
        "-g",
        `${PI_NPM_PACKAGE}@latest`,
        `--registry=${registry}`,
        "--no-fund",
        "--no-audit",
      ],
      {
        env: { ...env, npm_config_registry: registry },
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: `npm 全局安装失败：${msg}`,
      version: null,
      path: null,
      source: "none",
      npmRoot: null,
    };
  }

  let npmRoot: string | null = null;
  try {
    const { stdout } = await exec("npm", ["root", "-g"], {
      env,
      timeout: 30_000,
      encoding: "utf8",
    });
    npmRoot = String(stdout).trim() || null;
  } catch {
    npmRoot = null;
  }

  // 优先让 PATH 解析；若仍无 pi 且知道 npmRoot，写入 runtimeDir
  let resolved = resolveRuntimeBinary(env);
  if (!resolved.path && npmRoot) {
    const pkgDir = packageDirFromNpmRoot(npmRoot);
    if (existsSync(pkgDir) && options?.pinRuntimeDir !== false) {
      try {
        writeRuntimeConfig({ version: 1, runtimeDir: pkgDir });
      } catch {
        /* ignore */
      }
      // 同步进当前进程 env 探测：config 已写盘，resolve 会读到
      resolved = resolveRuntimeBinary(env);
    }
  }

  // 刷新进程内 PI_SUBAGENT_PI_BINARY
  const configured = configureRuntimeEnv(env);

  if (!configured.path) {
    return {
      ok: true,
      message:
        "已执行全局安装，但当前进程仍解析不到 pi。请确认 npm 全局 bin 在 PATH 中，或在设置中填写运行时目录后重试。",
      version: null,
      path: null,
      source: "none",
      npmRoot,
    };
  }

  return {
    ok: true,
    message: `已安装并解析到 Pi ${configured.version ?? "?"}（${configured.source}）`,
    version: configured.version,
    path: configured.path,
    source: configured.source,
    npmRoot,
  };
}
