/**
 * Pi agent 目录路径（不依赖 @earendil-works/pi-coding-agent）。
 * 与官方 getAgentDir 语义对齐：PI_CODING_AGENT_DIR → ~/.pi/agent
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 与 pi 的 ENV_AGENT_DIR 一致 */
export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** 用户 agent 配置根目录（~/.pi/agent 或 PI_CODING_AGENT_DIR）。 */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[PI_CODING_AGENT_DIR_ENV]?.trim();
  if (fromEnv) return expandTilde(fromEnv);
  return join(homedir(), ".pi", "agent");
}

export function getSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentDir(env), "sessions");
}

export function getModelsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentDir(env), "models.json");
}

export function getAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentDir(env), "auth.json");
}

export function getSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentDir(env), "settings.json");
}

/**
 * cwd → 会话子目录名（与 pi getDefaultSessionDirPath 一致）：
 * `--` + 去前导斜杠 + `/` `\` `:` 换成 `-` + `--`
 * 例：/root/works/open/pidance → --root-works-open-pidance--
 */
export function encodeCwdForSessionDir(cwd: string): string {
  const resolved = cwd.replace(/\\/g, "/");
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function getDefaultSessionDir(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(getSessionsDir(env), encodeCwdForSessionDir(cwd));
}
