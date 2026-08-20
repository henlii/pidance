import type { SessionInfo } from "@/lib/types";

/**
 * UI 层会话能力判定。readOnly（subagent 持久化）会话的一切写操作与
 * AgentSession 连接在 UI 侧先行拦截——后端 requireWritableSession 仍是
 * 权威防线，这里只是让按钮不亮、handler 早退、文案说得清。
 */
export interface SessionCapabilities {
  readOnly: boolean;
  /** 发送 / steer / follow-up / bash，任何会产生 prompt 的入口 */
  canPrompt: boolean;
  canFork: boolean;
  canCompact: boolean;
  canChangeModel: boolean;
  canChangeThinking: boolean;
  canChangeTools: boolean;
  canRename: boolean;
  canAutoName: boolean;
  canDelete: boolean;
  /** per-session events SSE / 任何会启动 AgentSession 的 RPC 命令 */
  canConnectEvents: boolean;
  /** navigate_tree 等写命令；只读会话分支导航降级为纯 GET context */
  canSendSessionCommands: boolean;
}

const WRITABLE_CAPABILITIES: SessionCapabilities = {
  readOnly: false,
  canPrompt: true,
  canFork: true,
  canCompact: true,
  canChangeModel: true,
  canChangeThinking: true,
  canChangeTools: true,
  canRename: true,
  canAutoName: true,
  canDelete: true,
  canConnectEvents: true,
  canSendSessionCommands: true,
};

const READ_ONLY_CAPABILITIES: SessionCapabilities = {
  readOnly: true,
  canPrompt: false,
  canFork: false,
  canCompact: false,
  canChangeModel: false,
  canChangeThinking: false,
  canChangeTools: false,
  canRename: false,
  canAutoName: false,
  canDelete: false,
  canConnectEvents: false,
  canSendSessionCommands: false,
};

export function getSessionCapabilities(
  session: Pick<SessionInfo, "readOnly"> | null | undefined,
): SessionCapabilities {
  if (session?.readOnly === true) return READ_ONLY_CAPABILITIES;
  return WRITABLE_CAPABILITIES;
}

/**
 * 归档能力判定（菜单项禁用逻辑）：
 * - 只读 subagent 会话不可归档（后端 403 门禁的 UI 先行拦截）；
 * - running 会话不可归档（后端 409，前端直接禁用并给出原因）。
 */
export function canArchiveSession(
  session: Pick<SessionInfo, "readOnly"> | null | undefined,
  isRunning: boolean,
): boolean {
  if (isRunning) return false;
  return getSessionCapabilities(session).readOnly === false;
}
