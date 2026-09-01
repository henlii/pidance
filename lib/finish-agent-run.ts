/**
 * P2 统一 agent run 结束路径的纯逻辑 seam。
 *
 * 三条结束路径（agent_end / prompt_done / reconcile idle）共用同一 finalizer：
 * - beginAgentRunFinish：进入异步收尾前的 token 校验并抢占 completion claim；
 * - canFinalizeAgentRun：loadSession 完成/失败后的二次校验。
 *
 * 旧 SSE source 排队回调在连接建立时捕获 runId（而非处理时读取），旧 reconcile
 * 响应在请求发出时捕获 runId——二者都携带旧 token，经 token 校验被丢弃，不会
 * 结束新 run。hook 只负责把 refs/state 映射成快照传入本 seam，副作用
 * （loadSession / setState / dispatch / onAgentEnd）由调用方执行。
 */

export interface AgentRunFinishContext {
  /** 调用方目标会话 id（事件/响应携带）；null 表示尚未有真实会话（跳过收尾） */
  sessionId: string | null;
  /** 当前会话 id（sessionIdRef.current 快照）；二者不一致视为已切换会话 */
  currentSessionId: string | null;
  /** 事件/响应携带的 run id（SSE 建立时或 reconcile 请求前捕获） */
  eventRunId: number;
  /** 当前 run id（promptRunIdRef.current 快照） */
  currentRunId: number;
  /** agent 是否仍处于运行态（agentRunningRef.current 快照） */
  running: boolean;
  /** 当前 completion claim（finishingPromptRunIdRef.current 快照）；null 表示空闲 */
  claimedRunId: number | null;
}

/**
 * 进入异步收尾的前置校验：会话一致（sid 非空且等于当前会话）、run token 匹配
 * （旧回调携带旧 id 会被丢弃）、确实在运行、claim 未被其它路径抢占。全部通过返回
 * true，调用方应在第一个 await 前立即写入 claim，防止 agent_end / prompt_done /
 * reconcile 为同一 run 重复进入异步收尾。
 */
export function beginAgentRunFinish(ctx: AgentRunFinishContext): boolean {
  if (ctx.sessionId === null) return false;
  if (ctx.sessionId !== ctx.currentSessionId) return false;
  if (ctx.eventRunId !== ctx.currentRunId) return false;
  if (!ctx.running) return false;
  if (ctx.claimedRunId !== null) return false;
  return true;
}

export interface AgentRunFinishFinalizeContext {
  /** 调用方目标会话 id（收尾开始时捕获） */
  sessionId: string | null;
  /** 当前会话 id（sessionIdRef.current 快照） */
  currentSessionId: string | null;
  /** 事件/响应携带的 run id */
  eventRunId: number;
  /** 当前 run id（promptRunIdRef.current 快照） */
  currentRunId: number;
  /** 收尾开始前写入的 claim；必须仍由本 run 持有 */
  claimedRunId: number | null;
}

/**
 * loadSession 完成/失败后的二次校验：期间切换会话或开启新 run 则放弃结束副作用，
 * 只有 token 仍匹配且 claim 仍由本 run 持有才允许执行（否则新 run 的 running 状态
 * 会被错误清除）。调用方无论结果如何都必须释放 claim，否则后续 run 的收尾路径
 * 会被旧 claim 永久阻塞。
 */
export function canFinalizeAgentRun(ctx: AgentRunFinishFinalizeContext): boolean {
  if (ctx.sessionId === null) return false;
  if (ctx.sessionId !== ctx.currentSessionId) return false;
  if (ctx.eventRunId !== ctx.currentRunId) return false;
  return ctx.claimedRunId === ctx.eventRunId;
}

export interface ReconcileIdleSnapshot {
  /** wake/prompt HTTP 仍在途：本进程 live 可能尚未建立 */
  sendInFlight: boolean;
  clientRunning: boolean;
  /** 本进程是否已有 live host（GET /api/agent/[id] 的 running 字段） */
  live: boolean;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isCompacting: boolean;
}

/**
 * reconcile 不得把「未知」当成「空闲」。
 * 无 live、发送尚未返回、或仍 busy 时都不能收尾，否则会出现：
 * 客户端已结束 running → 无法停止/引导，而服务端随后才真正跑起来。
 */
export function shouldFinishFromReconcile(snapshot: ReconcileIdleSnapshot): boolean {
  if (!snapshot.clientRunning || snapshot.sendInFlight || !snapshot.live) return false;
  return !snapshot.isStreaming && !snapshot.isPromptRunning && !snapshot.isCompacting;
}
