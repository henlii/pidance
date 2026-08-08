/**
 * Pidance → pi-subagents 的 pi CLI 桥接。
 *
 * pi-subagents 执行子代理时需 spawn pi CLI，其解析链为：
 *   1. PI_SUBAGENT_PI_BINARY 环境变量（本模块设置的入口）；
 *   2. process.argv[1] 探测 —— Next server 入口不是 pi，失败；
 *   3. import.meta.resolve —— 可能失败；
 *   4. fallback spawn("pi") —— 依赖 PATH。
 *
 * 产品默认只用外部 pi：优先 PIDANCE_PI_RUNTIME / PATH 上的 `pi`，
 * 不再依赖 @earendil-works/pi-coding-agent npm 包内的 dist/cli.js。
 */

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** pi-subagents 读取的环境变量名（镜像其 PI_SUBAGENT_PI_BINARY_ENV）。 */
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

function isRunnableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析外部 pi 二进制：PIDANCE_PI_RUNTIME → which pi → 常见路径。
 * 不使用 import.meta.url，避免 webpack 嵌入构建机绝对路径。
 */
export function resolvePidancePiCli(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env.PIDANCE_PI_RUNTIME?.trim();
  if (configured && isRunnableFile(configured)) return configured;

  try {
    const out = execFileSync("which", ["pi"], {
      encoding: "utf8",
      timeout: 5_000,
      env,
    }).trim();
    const path = out.split("\n")[0]?.trim();
    if (path && isRunnableFile(path)) return path;
  } catch {
    /* PATH 无 pi */
  }

  const home = env.HOME || "";
  const candidates = [
    join(home, ".local/bin/pi"),
    "/usr/local/bin/pi",
    join(home, ".nvm/versions/node", process.version, "bin/pi"),
  ];
  for (const candidate of candidates) {
    if (candidate && isRunnableFile(candidate)) return candidate;
  }

  // 兼容：若仍安装了 npm 包内 cli（过渡期），最后才回退
  const bundled = join(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  if (existsSync(bundled) && isRunnableFile(bundled)) return bundled;

  return null;
}

/**
 * 设置 PI_SUBAGENT_PI_BINARY 指向外部 pi；返回设置的路径，
 * 解析失败返回 null（调用方按可降级处理，不阻塞启动）。
 * Windows 无 shebang 直接执行语义，跳过。
 */
export function configurePiSubagentBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (process.platform === "win32") return null;
  const cli = resolvePidancePiCli(env);
  if (!cli) return null;
  process.env[PI_SUBAGENT_PI_BINARY_ENV] = cli;
  return cli;
}
