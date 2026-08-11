/**
 * 兼容再导出：主路径已迁到 live-session-registry + SdkSessionHost。
 * 保留文件名避免大面积改 import；新代码请直接 import live-session-registry。
 */
export {
  BRANCH_LABEL_MAX_LENGTH,
  parseNavigateTreeCommand,
  parseSetBranchLabelCommand,
  type NavigationActions,
  type AgentEvent,
  type LiveAgentSession,
  getRegistry,
  getRpcSession,
  getLiveSession,
  getRunningRpcSessionIds,
  getRunningSessionIds,
  subscribeRunningSessions,
  recordRunningStartedAt,
  clearRunningStartedAt,
  getRunningStartedAt,
  notifyRunningChange,
  rekeyLiveSession,
  startRpcSession,
  startLiveSession,
  awaitSessionStartLock,
} from "./live-session-registry";
