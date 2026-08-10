import type { SessionEntry } from "./types";

/**
 * 命令条目（type:"custom"，customType=pidance.command）。
 *
 * 斜杠命令（/compact、/reload、/name 等）执行成功后由 Pidance 追加到会话文件，
 * 使命令在会话时间线中可见。type:"custom" 不参与 Pi 的 LLM 上下文
 * （Pi 0.83 sessionEntryToContextMessages 忽略该类型），与 pidance.activity 同模式。
 */
export const PIDANCE_COMMAND_CUSTOM_TYPE = "pidance.command";

export interface CommandEntryData {
  /** 完整命令文本（含 / 前缀与参数），如 "/compact" 或 "/name 会话名"。 */
  command: string;
  /** 命令执行是否成功；失败时不写条目（仅成功落盘）。 */
  ok: boolean;
  /** 成功提示/结果简述（可选）。 */
  result?: string;
  /** 写入版本；未知版本安全跳过。 */
  version?: number;
}

export function normalizeCommandEntryData(input: {
  command: string;
  ok?: boolean;
  result?: string;
}): CommandEntryData {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  return {
    command,
    ok: input.ok !== false,
    result: typeof input.result === "string" && input.result.trim() !== "" ? input.result.trim() : undefined,
    version: 1,
  };
}

/** 解析磁盘条目 data；非法返回 null（安全跳过）。 */
export function parseCommandEntryData(data: unknown): CommandEntryData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return null;
  if (typeof d.command !== "string" || d.command.trim() === "") return null;
  return {
    command: d.command,
    ok: d.ok !== false,
    result: typeof d.result === "string" ? d.result : undefined,
    version: 1,
  };
}

/** 从 entries 中按 id 查命令条目（测试/审计用）。 */
export function findCommandEntry(entries: SessionEntry[], id: string): CommandEntryData | null {
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.type !== "custom" || entry.customType !== PIDANCE_COMMAND_CUSTOM_TYPE) return null;
  return parseCommandEntryData((entry as { data?: unknown }).data);
}
